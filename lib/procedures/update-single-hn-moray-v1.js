/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');

var errors = require('../errors'),
    InternalError = errors.InternalError;
var common = require('../common');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
/**
 * First pass procedure for updating moray service
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateSingleHNMorayV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateSingleHNMorayV1, Procedure);

UpdateSingleHNMorayV1.prototype.summarize = function morayv1Summarize() {
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};


UpdateSingleHNMorayV1.prototype.execute = function morayv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.logCb, 'opts.logCb');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = opts.sdcadm;
    var log = opts.log;
    var logCb = opts.logCb;
    // Mirroring UpdateStatelessServicesV1 above, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateMoray
    }, cb);


    function updateMoray(change, nextSvc) {
        var inst = change.inst;
        var svc = change.service;
        var HA = false;
        var tmpAlias = inst.alias + 'tmp';
        var tmpUUID;
        var arg = {
            change: change,
            opts: opts,
            userScript: false
        };
        vasync.pipeline({funcs: [
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript,
            s.updateVmUserScript,
            s.updateSapiSvc,
            s.imgadmInstall,

            function checkHA(_, next) {
                logCb('Verifying if we are on an HA setup');
                sdcadm.sapi.listInstances({
                    service_uuid: svc.uuid
                }, function (err, instances) {
                    if (err) {
                        next(err);
                    } else {
                        if (instances.length > 1) {
                            HA = true;
                        }
                        next();
                    }
                });
            },

            /**
             * Create a temporary "morayXtmp" instance when no HA
             */
            function provisionTmpVm(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Provisioning Temporary %s VM %s', inst.service,
                    tmpAlias));
                log.trace({alias: tmpAlias, image: change.image.uuid},
                    'Provisioning temporary VM inst');
                sdcadm.sapi.createInstance(svc.uuid, {
                    params: {
                        owner_uuid: sdcadm.config.ufds_admin_uuid,
                        alias: tmpAlias
                    }
                }, function (err, body) {
                    if (err) {
                        return next(err);
                    }
                    tmpUUID = body.uuid;
                    return next();
                });
            },

            function waitForTmpInstToBeUp(_, next) {
                if (HA) {
                    return next();
                }
                // For now we are using the lame sleep from incr-upgrade's
                // upgrade-all.sh.
                // TODO: improve this to use instance "up" checks from TOOLS-551
                logCb(format('Wait (sleep) for %s instance %s to come up',
                    inst.service, tmpUUID));
                setTimeout(next, 15 * 1000);
            },

            function getTmpInstanceUUID(_, next) {
                if (HA) {
                    return next();
                }
                logCb('Running vmadm lookup to get tmp instance UUID');
                var argv = [
                    '/usr/sbin/vmadm',
                    'lookup',
                    '-1',
                    'alias=' + tmpAlias
                ];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        tmpUUID = stdout.trim();
                        log.debug('Tmp instance found: %s',
                            tmpUUID);
                        next();
                    }
                });
            },

            function checkIfTmpVMHasErrors(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Checking if tmp instace %s services have errors',
                            tmpUUID));
                var argv = ['/usr/bin/svcs', '-z', tmpUUID, '-x'];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        return next(err);
                    }
                    var errs = stdout.trim();
                    if (errs) {
                        return next(errs);
                    }
                    return next();
                });
            },

            function waitUntilTmpInDNS(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Waiting for tmp instace %s to be in DNS',
                            tmpUUID));
                common.waitUntilZoneInDNS({
                    uuid: tmpUUID,
                    alias: tmpAlias,
                    domain: svc.metadata.SERVICE_DOMAIN,
                    log: log
                }, next);
            },

            function disableVMRegistrar(_, next) {
                logCb(format('Disabling registrar on VM %s', inst.zonename));
                svcadm.svcadmDisable({
                    fmri: 'registrar',
                    zone: inst.zonename,
                    wait: true,
                    log: log
                }, next);
            },

            function waitUntilVMNotInDNS(_, next) {
                logCb(format('Wait until VM %s is out of DNS', inst.zonename));
                common.waitUntilZoneOutOfDNS({
                    uuid: inst.zonename,
                    alias: inst.alias,
                    domain: svc.metadata.SERVICE_DOMAIN,
                    log: log
                }, next);
            },

            s.reprovision,
            s.waitForInstToBeUp,

            function waitUntilVmInDNS(_, next) {
                logCb(format('Waiting until %s isntance is in DNS',
                    inst.uuid));
                common.waitUntilZoneInDNS({
                    uuid: inst.zonename,
                    alias: inst.alias,
                    domain: svc.metadata.SERVICE_DOMAIN,
                    log: log
                }, next);
            },

            function disableTmpVMRegistrar(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Disable registrar on tmp VM %s',
                    tmpUUID));
                svcadm.svcadmDisable({
                    fmri: 'registrar',
                    zone: tmpUUID,
                    wait: true,
                    log: log
                }, next);
            },

            function waitUntilTmpVMNotInDNS(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Wait until tmp VM %s is out of DNS',
                    tmpUUID));
                common.waitUntilZoneOutOfDNS({
                    uuid: tmpUUID,
                    alias: tmpAlias,
                    domain: svc.metadata.SERVICE_DOMAIN,
                    log: log
                }, next);
            },

            function stopTmpVm(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Stop tmp VM %s', tmpUUID));
                vmadm.vmStop(tmpUUID, {
                    log: log
                }, next);
            },

            function destroyTmpVM(_, next) {
                if (HA) {
                    return next();
                }
                logCb(format('Destroying tmp VM %s (%s)', tmpUUID, tmpAlias));
                sdcadm.sapi.deleteInstance(tmpUUID, next);
            }


        ], arg: arg}, nextSvc);
    }
};
//---- exports

module.exports = {
    UpdateSingleHNMorayV1: UpdateSingleHNMorayV1
};
// vim: set softtabstop=4 shiftwidth=4:
