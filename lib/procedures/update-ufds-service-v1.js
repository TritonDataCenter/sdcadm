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
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};


UpdateUFDSServiceV1.prototype.execute = function ufdsv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.logCb, 'opts.logCb');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var log = opts.log;
    var logCb = opts.logCb;
    // Mirroring UpdateStatelessServicesV1 above, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateUFDS
    }, cb);


    function updateUFDS(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false
        };
        var manateeUUID;
        vasync.pipeline({funcs: [
            function getLocalManatee(_, next) {
                logCb('Running vmadm lookup to get local manatee');
                var argv = [
                    '/usr/sbin/vmadm',
                    'lookup',
                    '-1',
                    'state=running',
                    'tags.smartdc_role=manatee'
                ];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        var manatees = stdout.trim().split('\n');
                        manateeUUID = manatees[0];
                        log.debug('Local manatee instance found: %s',
                            manateeUUID);
                        next();
                    }
                });
            },
            /**
             * We want to backup UFDS data before we proceed with the upgrade.
             * If the HN manatee is the async copy, that might be outdated, and
             * our backup would be useless. Do not upgrade on such case for now
             */
            function bailIfManateeIsAsync(_, next) {
                logCb('Running manatee-stat');
                var argv = [
                    '/usr/sbin/zlogin',
                    manateeUUID,
                    'source .bashrc; manatee-stat -p $ZK_IPS'
                ];

                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        // REVIEW: Shall we try/catch here?
                        var manateeCfg = JSON.parse(stdout);
                        if (!manateeCfg.sdc) {
                            next('Cannot find manatee sdc shard config');
                        } else {
                            if (manateeCfg.sdc.async &&
                                manateeCfg.sdc.async.zoneId === manateeUUID)
                            {
                                next('Local manatee is async, ' +
                                    'cannot backup ufds buckets');
                            } else {
                                next();
                            }
                        }
                    }
                });
            },

            function backupUFDSBuckets(_, next) {
                var bPath = '/var/sdcadm/ufds-backup';
                var t = new Date().toISOString().replace(/[-:\.Z]/g, '');
                var bFile = bPath + '/' + t + '.sql';
                var exists = fs.existsSync(bPath);
                if (!exists) {
                    fs.mkdirSync(bPath);
                }

                logCb(format('Creating ufds buckets backup %s', bFile));
                var argv = [
                    '/usr/sbin/zlogin',
                    manateeUUID,
                    '/opt/local/bin/pg_dump -U moray -t \'ufds*\' moray'
                ];

                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        return next(err);
                    }

                    return fs.writeFile(bFile, stdout, {
                        encoding: 'utf8'
                    }, function (err2) {
                        if (err2) {
                            return next(err2);
                        }
                        return next();
                    });
                });
            },
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript,
            s.updateVmUserScript,
            s.updateSapiSvc,
            s.imgadmInstall,
            s.reprovision,
            s.waitForInstToBeUp
        ], arg: arg}, nextSvc);
    }
};

//---- exports

module.exports = {
    UpdateUFDSServiceV1: UpdateUFDSServiceV1
};
// vim: set softtabstop=4 shiftwidth=4:
