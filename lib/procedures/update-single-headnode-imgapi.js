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
 * A limited first attempt procedure for updating imgapi.
 *
 * This is the first replacement for "upgrade-imgapi.sh" from the
 * incr-upgrade scripts.
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateSingleHeadnodeImgapi(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateSingleHeadnodeImgapi, Procedure);

UpdateSingleHeadnodeImgapi.prototype.summarize = function ushiSummarize() {
    var word = (this.changes[0].type === 'rollback-service') ?
        'rollback' : 'update';
    return this.changes.map(function (ch) {
        return sprintf('%s "%s" service to image %s (%s@%s)', word,
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};

UpdateSingleHeadnodeImgapi.prototype.execute = function ushiExecute(opts, cb) {
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
    var rollback = opts.plan.rollback || false;

    function updateImgapi(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false
        };
        var inst = change.inst;

        if (opts.plan.changes.length > 1) {
            progress('');
            progress('--- Updating %s ...', change.service.name);
        }

        var funcs = [
            function bailIfImgapiHasNoDelegate(_, next) {
                vmadm.vmGet(inst.zonename, {log: log}, function (err, vm) {
                    if (err) {
                        return next(err);
                    }
                    var expectedDs = sprintf('zones/%s/data', inst.zonename);
                    log.debug({expectedDs: expectedDs, vm: vm}, 'imgapi vm');
                    if (vm.datasets.indexOf(expectedDs) === -1) {
                        return next(new errors.UpdateError(format(
                            'imgapi vm %s has no "%s" delegate dataset, ' +
                            'upgrading it would lose image file data',
                            vm.uuid, expectedDs)));
                    }
                    next();
                });
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
            s.waitForInstToBeUp,
            /**
             * Run old migrations if necessary. These are imgapi migration
             * scripts that predate any of the sdcMigration spec work for
             * "how thou shalt do migrations in SDC services".
             *
             * Given a current svcMinImages.imgapi=20140619T081912Z, we
             * definitely don't need to run migrations 007 and below. Possibly
             * some of the others are unnecessary now as well.
             *
             * TODO(trent): get imgapi on semver, then can use base version
             * at which to know that migrations will already have been done.
             */
            function disableImgapi(_, next) {
                progress('Disabling imgapi service');
                svcadm.svcadmDisable({
                    fmri: 'imgapi',
                    zone: inst.zonename,
                    wait: true,
                    log: log
                }, next);
            },
            function imgapiMigration008(_, next) {
                progress('Running IMGAPI migration-008-new-storage-layout.js');
                var argv = [
                    '/usr/sbin/zlogin',
                    inst.zonename,
                    'cd /opt/smartdc/imgapi && ./build/node/bin/node ' +
                        'lib/migrations/migration-008-new-storage-layout.js'
                ];
                common.spawnRun({argv: argv, log: log}, next);
            },
            function imgapiMigration009(_, next) {
                progress('Running IMGAPI migration-009-backfill-archive.js');
                var argv = [
                    '/usr/sbin/zlogin',
                    inst.zonename,
                    'cd /opt/smartdc/imgapi && ./build/node/bin/node ' +
                        'lib/migrations/migration-009-backfill-archive.js'
                ];
                common.spawnRun({argv: argv, log: log}, next);
            },
            function imgapiMigration010(_, next) {
                progress('Running IMGAPI ' +
                    'migration-010-backfill-billing_tags.js');
                var argv = [
                    '/usr/sbin/zlogin',
                    inst.zonename,
                    'cd /opt/smartdc/imgapi && ./build/node/bin/node ' +
                        'lib/migrations/migration-010-backfill-billing_tags.js'
                ];
                common.spawnRun({argv: argv, log: log}, next);
            },
            function imgapiMigration011(_, next) {
                progress('Running IMGAPI ' +
                    'migration-011-backfill-published_at.js');
                var argv = [
                    '/usr/sbin/zlogin',
                    inst.zonename,
                    'cd /opt/smartdc/imgapi && ./build/node/bin/node ' +
                        'lib/migrations/migration-011-backfill-published_at.js'
                ];
                common.spawnRun({argv: argv, log: log}, next);
            },
            function imgapiMigration012(_, next) {
                progress('Running IMGAPI ' +
                    'migration-012-update-docker-image-uuids.js (if exists)');
                var argv = [
                    '/usr/sbin/zlogin',
                    inst.zonename,
                    /* BEGIN JSSTYLED */
                    'cd /opt/smartdc/imgapi && ' +
                        'test ! -f lib/migrations/migration-012-update-docker-image-uuids.js || ' +
                        './build/node/bin/node lib/migrations/migration-012-update-docker-image-uuids.js'
                    /* END JSSTYLED */
                ];
                common.spawnRun({argv: argv, log: log}, next);
            },
            function enableImgapi(_, next) {
                progress('Enabling imgapi service');
                svcadm.svcadmEnable({
                    fmri: 'imgapi',
                    zone: inst.zonename,
                    wait: true,
                    log: log
                }, next);
            }
        ]), arg: arg}, nextSvc);
    }

    // Mirroring UpdateStatelessServicesV1, even though here we should
    // only have one instance.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateImgapi
    }, cb);
};
//---- exports

module.exports = {
    UpdateSingleHeadnodeImgapi: UpdateSingleHeadnodeImgapi
};
// vim: set softtabstop=4 shiftwidth=4:
