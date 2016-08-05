/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var format = util.format;
var vasync = require('vasync');
var fs = require('fs');
var path = require('path');

var errors = require('../errors');
var common = require('../common');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');

var Procedure = require('./procedure').Procedure;
var shared = require('./shared');

/*
 * As of TOOLS-1510, adding indices for which **no reindexing** is needed is
 * done with a single program that drives the addition of all indices.
 */
var VMAPI_ADD_ALL_INDICES_SCRIPT =
    ['tools', 'migrations', 'add-new-indices-no-reindex-needed',
        'add-all-new-indices-no-reindex-needed.js'].join(path.sep);

/*
 * However, if the update procedure upgrades VMAPI to a version for which this
 * new program that adds all indices is not present, then it will fall back, if
 * present, to the old script that was used to add an index on the "docker"
 * property of VM objects.
 */
var VMAPI_OLD_ADD_DOCKER_INDEX_SCRIPT = 'tools/migrations/add-docker-index.js';

/**
 * Procedure for updating vmapi.
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 */
function UpdateSingleHeadnodeVmapi(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateSingleHeadnodeVmapi, Procedure);

UpdateSingleHeadnodeVmapi.prototype.summarize = function ushiSummarize() {
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

UpdateSingleHeadnodeVmapi.prototype.execute = function ushiExecute(opts, cb) {
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

    function updateVmapi(change, nextSvc) {
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

        var funcs = [];

        if (rollback) {
            funcs.push(shared.getOldUserScript);
        } else {
            funcs.push(shared.getUserScript);
            funcs.push(shared.writeOldUserScriptForRollback);
        }

        vasync.pipeline({funcs: funcs.concat([
            shared.updateSvcUserScript,
            shared.updateVmUserScript,
            shared.updateSapiSvc,
            shared.imgadmInstall,
            shared.reprovision,
            shared.waitForInstToBeUp,
            /*
             * Disabling VMAPI service so that it doesn't interfere with
             * migrations.
             */
            function disableVmapi(_, next) {
                progress('Disabling vmapi service');
                svcadm.svcadmDisable({
                    fmri: 'vmapi',
                    zone: inst.zonename,
                    wait: true,
                    log: log
                }, next);
            },
            function runAddIndicesWithNoReindexingMigrations(_, next) {
                progress('Running VMAPI migrations: adding indices requiring '
                    + 'no reindexing');

                var context = {
                    migrationsDone: false,
                    hasAllIndicesMigrationScript: false,
                    hasAddDockerIndexMigrationScript: false
                };

                vasync.pipeline({funcs: [
                    function hasAllIndicesMigrationScript(ctx, done) {
                        var scriptFilePath = [
                            '/zones',
                            inst.zonename,
                            'root',
                            'opt/smartdc/vmapi',
                            VMAPI_ADD_ALL_INDICES_SCRIPT
                        ].join(path.sep);

                        progress('Checking if ' + VMAPI_ADD_ALL_INDICES_SCRIPT
                            + ' is present');

                        fs.lstat(scriptFilePath,
                            function scriptFileLstated(err) {
                                if (err) {
                                    ctx.hasAllIndicesMigrationScript = false;
                                } else {
                                    ctx.hasAllIndicesMigrationScript = true;
                                }

                                done();
                            });
                    },
                    function runAllIndicesMigratioNScript(ctx, done) {
                        if (!ctx.hasAllIndicesMigrationScript) {
                            progress(VMAPI_ADD_ALL_INDICES_SCRIPT + ' not '
                                + 'present, skipping');
                            done();
                            return;
                        }

                        var runAllIndicesMigrationScriptArgv = [
                            '/usr/sbin/zlogin',
                            inst.zonename,
                            'cd /opt/smartdc/vmapi && ' +
                                './build/node/bin/node ' +
                                VMAPI_ADD_ALL_INDICES_SCRIPT
                        ];

                        progress('Running ' + VMAPI_ADD_ALL_INDICES_SCRIPT);
                        common.spawnRun({
                            argv: runAllIndicesMigrationScriptArgv,
                            log: log
                        }, function allIndicesMigrationScriptRan(err) {
                            /*
                             * Regardless of errors during the execution of the
                             * migration program, the migration process is
                             * considered done. If errors were encountered, the
                             * migration process should not try to run
                             * potentially outdated migration programs. Instead,
                             * it should stop so that the problem can be
                             * diagnosed.
                             */
                            ctx.migrationsDone = true;
                            done(err);
                        });
                    },
                    function hasAddDockerIndexMigrationScript(ctx, done) {
                        var scriptFilePath = [
                            '/zones',
                            inst.zonename,
                            'root',
                            'opt/smartdc/vmapi',
                            VMAPI_OLD_ADD_DOCKER_INDEX_SCRIPT
                        ].join(path.sep);

                        if (ctx.migrationsDone) {
                            done();
                            return;
                        }

                        progress('Checking if '
                            + VMAPI_OLD_ADD_DOCKER_INDEX_SCRIPT + ' is '
                            + 'present');
                        fs.lstat(scriptFilePath,
                            function scriptFileLstated(err) {
                                if (!err) {
                                    ctx.hasAddDockerIndexMigrationScript = true;
                                }

                                done();
                            });
                    },
                    function runAddDockerIndexMigrationScript(ctx, done) {
                        if (ctx.migrationsDone) {
                            done();
                            return;
                        }

                        if (!ctx.hasAddDockerIndexMigrationScript) {
                            progress(VMAPI_OLD_ADD_DOCKER_INDEX_SCRIPT + ' not '
                                + 'present, skipping');
                            done();
                            return;
                        }

                        var runAddDockerIndexMigrationScriptArgv = [
                            '/usr/sbin/zlogin',
                            inst.zonename,
                            'cd /opt/smartdc/vmapi && ' +
                                './build/node/bin/node ' +
                                VMAPI_OLD_ADD_DOCKER_INDEX_SCRIPT
                        ];

                        progress('Running ' +
                            VMAPI_OLD_ADD_DOCKER_INDEX_SCRIPT);
                        common.spawnRun({
                            argv: runAddDockerIndexMigrationScriptArgv,
                            log: log
                        }, function allIndicesMigrationScriptRan(err) {
                            /*
                             * Regardless of errors during the execution of the
                             * migration program, the migration process is
                             * considered done. If errors were encountered, the
                             * migration process should not try to run
                             * potentially outdated migration programs. Instead,
                             * it should stop so that the problem can be
                             * diagnosed.
                             */
                            ctx.migrationsDone = true;
                            done(err);
                        });
                    }
                ],
                arg: context
                }, next);
            },
            function enableVmapi(_, next) {
                progress('Enabling vmapi service');
                svcadm.svcadmEnable({
                    fmri: 'vmapi',
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
        func: updateVmapi
    }, cb);
};
//---- exports

module.exports = {
    UpdateSingleHeadnodeVmapi: UpdateSingleHeadnodeVmapi
};
// vim: set softtabstop=4 shiftwidth=4:
