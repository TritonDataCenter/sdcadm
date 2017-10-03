/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var format = util.format;
var fs = require('fs');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
/**
 * First pass procedure for updating UFDS service
 * services.
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateUFDSServiceV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateUFDSServiceV1, Procedure);

UpdateUFDSServiceV1.prototype.summarize = function uufdsv1Summarize() {
    if (this.changes[0].type === 'update-instance') {
        return this.changes.map(function (ch) {
            return sprintf('update instance "%s" (%s)\n' +
                    'of service "%s" to image %s\n', ch.inst.instance,
                    ch.inst.alias, ch.service.name, ch.image.uuid) +
                common.indent(sprintf('(%s@%s)',
                    ch.image.name, ch.image.version));
        }).join('\n');
    } else {
        var word = (this.changes[0].type === 'rollback-service') ?
            'rollback' : 'update';
        return this.changes.map(function (ch) {
            return sprintf('%s "%s" service to image %s\n', word,
                    ch.service.name, ch.image.uuid) +
                common.indent(sprintf('(%s@%s)',
                    ch.image.name, ch.image.version));
        }).join('\n');
    }
};


UpdateUFDSServiceV1.prototype.execute = function ufdsv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var log = opts.log;
    var progress = opts.progress;
    var rollback = opts.plan.rollback || false;

    function updateUFDS(change, nextSvc) {
        var ctx = {
            change: change,
            opts: opts,
            userScript: false
        };

        var t = new Date().toISOString().replace(/[\-:\.Z]/g, '');

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [
            function getManateeVms(arg, next) {
                opts.sdcadm.vmapi.listVms({
                    'tag.smartdc_role': 'manatee',
                    state: 'running'
                }, function listVmsCb(vmsErr, vms) {
                    if (vmsErr) {
                        next(vmsErr);
                        return;
                    }
                    if (!Array.isArray(vms) || !vms.length || !vms[0]) {
                        next(new errors.SDCClientError(new Error(
                            'No manatee "vms" found'), 'vmapi'));
                        return;
                    }

                    var errs = [];
                    vms.forEach(function validateVmFormat(vm) {
                        if (!vm.uuid || !common.UUID_RE.test(vm.uuid) ||
                            !vm.server_uuid ||
                            !common.UUID_RE.test(vm.server_uuid)) {
                                errs.push(new errors.ValidationError({
                                        message: util.format(
                                            'Invalid manatee VM format: %j',
                                            JSON.stringify(vm))
                                }));
                            }
                    });
                    if (errs.length) {
                        if (errs.length === 1) {
                            next(errs[0]);
                        } else {
                            next(new errors.MultiError(errs));
                        }
                        return;
                    }
                    arg.manateeVms = vms;
                    next();
                });
            },

            /**
             * We want to backup UFDS data before we proceed with the upgrade.
             * Either the primary or the sync manatees are good to take the data
             * backup there.
             */
            function findPrimaryManatee(arg, next) {
                progress('Running manatee-adm to find primary manatee');

                common.manateeAdmRemote({
                    server: arg.manateeVms[0].server_uuid,
                    vm: arg.manateeVms[0].uuid,
                    cmd: 'status',
                    log: log
                }, function (err, stdout, _) {
                    if (err) {
                        next(err);
                        return;
                    }
                    var manateeCfg;
                    try {
                        manateeCfg = JSON.parse(stdout);
                    } catch (e) {
                        next(e);
                        return;
                    }
                    if (!manateeCfg.sdc) {
                        next(new errors.InternalError(
                            'Cannot find manatee sdc shard config'));
                        return;
                    }

                    if (!manateeCfg.sdc.primary ||
                        !manateeCfg.sdc.primary.zoneId ||
                        !common.UUID_RE.test(manateeCfg.sdc.primary.zoneId)) {
                        next(new errors.InternalError(
                            'Unexpected manatee sdc shard config format'));
                        return;
                    }

                    var primaryArr = arg.manateeVms.filter(
                        function filterManateeVms(vm) {
                            return (vm.uuid === manateeCfg.sdc.primary.zoneId);
                    });

                    if (primaryArr.length !== 1) {
                        next(new errors.InternalError(
                            'Cannot find manatee sdc shard primary'));
                        return;
                    }

                    arg.primaryManatee = primaryArr[0];
                    next();
                });
            },

            function backupUFDSBuckets(arg, next) {
                progress('Creating ufds buckets backup %s.sql', t);
                var argv = [
                    '/opt/smartdc/bin/sdc-oneachnode',
                    format('-T%d', opts.ufds_backup_timeout),
                    format('-n %s ', arg.primaryManatee.server_uuid),
                    format('/usr/sbin/zlogin %s ', arg.primaryManatee.uuid) +
                    '\'/opt/local/bin/pg_dump -U moray -t ufds* ' +
                            'moray\' > /var/tmp/' + t + '.sql'
                ];

                common.execFilePlus({
                    argv: argv,
                    log: log
                }, next);
            },

            function copyBackupToHeadnode(arg, next) {
                progress('Copying backup file to HeadNode');
                var argv = [
                    '/opt/smartdc/bin/sdc-oneachnode',
                    format('-n %s', arg.primaryManatee.server_uuid),
                    format('-p/var/tmp/%s.sql', t),
                    format('-d/var/tmp'),
                    format('-T%d', opts.ufds_backup_timeout),
                    '-X'
                ];

                common.execFilePlus({
                    argv: argv,
                    log: log
                }, next);
            },

            function moveBackupToWorkingDir(arg, next) {
                progress('Moving backup file to /var/sdcadm/ufds-backup');
                var bPath = '/var/sdcadm/ufds-backup';
                var exists = fs.existsSync(bPath);
                if (!exists) {
                    fs.mkdirSync(bPath);
                }

                var argv = [
                    '/usr/bin/mv',
                    format('/var/tmp/%s', arg.primaryManatee.server_uuid),
                    format('%s/%s.sql', bPath, t)
                ];

                common.execFilePlus({
                    argv: argv,
                    log: log
                }, next);
            }
        ];

        if (rollback) {
            funcs.push(s.getOldUserScript);
        } else {
            funcs.push(s.getUserScript);
            funcs.push(s.writeOldUserScriptForRollback);
        }

        vasync.pipeline({funcs: funcs.concat([
            s.updateSvcUserScript,
            s.updateVmUserScript,
            s.updateSapiSvc,
            s.imgadmInstall,
            s.reprovision,
            s.waitForInstToBeUp
        ]), arg: ctx}, nextSvc);
    }

    // Mirroring UpdateStatelessServicesV1, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateUFDS
    }, cb);
};

// --- exports

module.exports = {
    UpdateUFDSServiceV1: UpdateUFDSServiceV1
};
// vim: set softtabstop=4 shiftwidth=4:
