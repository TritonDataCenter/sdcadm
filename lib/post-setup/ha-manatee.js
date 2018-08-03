/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * 'sdcadm post-setup ha-manatee'
 */

var p = console.log;
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');
var assert = require('assert-plus');

var util = require('util');

var common = require('../common');
var svcadm = require('../svcadm');
var errors = require('../errors');
var shared = require('../procedures/shared');
var steps = require('../steps');



// --- globals

var MIN_V2_TIMESTAMP = '20141218T222828Z';
// From here we have manatee-adm 2.1+ and all the new commands it provides
// instead of the deprecated ones
var MIN_V21_TIMESTAMP = '20150320T174220Z';

// --- CLI

function do_ha_manatee(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    if (!opts.servers || !opts.servers.length ||
            opts.servers.length !== 2) {
        cb(new errors.UsageError('Must specify 2 target servers'));
        return;
    }


    // Run the manatee-adm subcommand given by "cmd" into the provided server.
    // We assume that there will be a manatee VM with UUID vmUUID into the
    // given server.
    function manateeAdm(manateeUUID, cmd, callback) {
        var argv = [
            '/usr/sbin/zlogin',
            manateeUUID,
            'source ~/.bashrc; ' +
            '/opt/smartdc/manatee/node_modules/.bin/manatee-adm ' + cmd
        ];

        common.execFilePlus({
            argv: argv,
            log: self.log
        }, callback);
    }


    function waitForHA(localManateeUUID, hasManatee21, callback) {

        function syncReplStatus(manateeUUID, _isManatee21, _cb) {
            var cmd = hasManatee21 ?
                'pg-status -H -r primary -o pg-repl' : 'status';

            function statusCb(err, stdout, stderr) {
                if (err) {
                    _cb(err);
                    return;
                }
                if (hasManatee21) {
                    var out = stdout.split('\n')[0].trim(/\s+/);
                    _cb(null, out);
                } else {
                    var o = JSON.parse(stdout);
                    var isSync = (o.sdc.primary && o.sdc.sync &&
                        o.sdc.primary.repl &&
                        o.sdc.primary.repl.sync_state === 'sync');
                    _cb(null, (isSync ? 'sync' : '-'));
                }
            }

            manateeAdm(manateeUUID, cmd, statusCb);
        }

        var counter = 0;
        var limit = 60;
        function _waitForHA() {
            syncReplStatus(localManateeUUID, hasManatee21, function (err, st) {
                if (err) {
                    callback(err);
                    return;
                }
                if (st && st === 'sync') {
                    callback();
                } else {
                    if (counter < limit) {
                        setTimeout(_waitForHA, 5000);
                    } else {
                        callback('Timeout (5m) waiting for HA');
                    }
                }
            });
        }
        _waitForHA();
    }


    function restartSitter(server, zone, callback) {
        shared.restartRemoteSvc({
            server: server,
            zone: zone,
            fmri: 'manatee-sitter',
            log: self.log
        }, callback);
    }


    // This is the primary instance VM:
    var pri;
    // This is the secondary instance VM, if it exists when we run the process
    // (for example, from a previously failed attempt). Intentionally calling
    // it 'secondary' here. We don't really care about manatee replication
    // status at this point.
    var sry;
    // The existing instances, as they are retrieved from SAPI:
    var instances;
    // This is the manatee service from SAPI:
    var svc;
    // This is the current image being used, obtained from primary VM details:
    var img;
    // The shard state when we begin the process
    var shardState;

    var changes = [];
    var newId;
    // Have manatee-adm version 2.1+
    var manateeAdm21 = false;

    // This will be used for async manatee:
    var arg = {
        change: {
            server: opts.servers[1]
        },
        opts: {
            progress: self.progress,
            sdcadm: self.sdcadm,
            log: self.log
        },
        userScript: false,
        alias: 'manatee2'
    };

    var duplicatedServers = false;

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function checkTargetServer(_, next) {
            self.progress('Verifying target severs "%j" exist', opts.servers);
            self.sdcadm.cnapi.listServers({
                setup: true
            }, function (sErr, servers_) {
                if (sErr) {
                    next(sErr);
                    return;
                }
                var servers = servers_.filter(function (s) {
                    return (opts.servers.indexOf(s.uuid) !== -1);
                });
                // Check if any of the provided servers is duplicate:
                var unique = opts.servers.filter(function (item, pos, ary) {
                    return (ary.indexOf(item) === pos);
                });
                if (unique.length !== opts.servers.length) {
                    duplicatedServers = true;
                }

                if (unique.length !== servers.length) {
                    var msg = 'Either you haven\'t provided ' +
                        ' valid Server UUIDs, or the ones you\'ve provided ' +
                        'do not belong to servers setup in CNAPI.\nPlease ' +
                        'provide the UUIDs for 2 ' +
                        ' setup servers.';
                    next(new errors.UsageError(msg));
                    return;
                }
                next();
            });
        },

        function getManateeServices(_, next) {
            self.progress('Getting SDC\'s manatee details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'manatee',
                application_uuid: self.sdcadm.sdcApp.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                }

                assert.arrayOfObject(svcs);
                if (svcs.length !== 1) {
                    next(new errors.SDCClientError(new Error(
                        'Wanted 1 "manatee" service, found ' + svcs.length),
                        'sapi'));
                    return;
                }

                arg.change.service = svc = svcs[0];
                next();
            });
        },

        function updateManateeSizeParameters(_, next) {
            /*
             * Before we reconfigure Manatee, make sure any updates to the
             * service and instance parameters have been applied.
             */
            steps.updateSizeParameters({
                progress: self.progress,
                service: svc,
                log: self.log,
                sdcadm: self.sdcadm,
                params: self.sdcadm.config.updatedSizeParameters.manatee
            }, next);
        },

        function getManateeInstances(_, next) {
            self.progress('Getting SDC\'s manatee instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    next(instErr);
                    return;
                }

                if (!insts.length) {
                    next(new errors.SDCClientError(new Error(
                        'Unable to find first manatee instance'), 'sapi'));
                    return;
                }

                if (insts.length > 2) {
                    next(new errors.UsageError(
                        'You already have ' + insts.length +
                        ' manatee instances.\n' +
                        '"sdcadm post-setup ha-manatee" only has sense ' +
                        'when you have a single manatee instance\n' +
                        'or are trying to recover from a previous failure' +
                        'where the creation of the 2nd and/or \n' +
                        '3rd instance failed'));
                    return;
                }

                instances = insts;
                next();
            });
        },

        function getPrimaryManateeVm(_, next) {
            self.progress('Getting primary manatee details from VMAPI');
            var uuid = instances.filter(function (i) {
                return (i.params.alias === 'manatee0');
            })[0].uuid;
            self.sdcadm.vmapi.getVm({
                uuid: uuid
            }, function (vmErr, obj) {
                if (vmErr) {
                    next(vmErr);
                    return;
                }
                pri = obj;
                next();
            });
        },

        function getImage(_, next) {
            self.sdcadm.imgapi.getImage(pri.image_uuid, {}, function (err, im) {
                if (err) {
                    next(err);
                } else {
                    img = im;
                    arg.change.image = img;
                    next();
                }
            });
        },

        function getSecondaryManateeVm(_, next) {
            if (instances.length < 2) {
                next();
                return;
            }
            var uuid = instances.filter(function (i) {
                return (i.params.alias === 'manatee1');
            })[0].uuid;
            self.progress('Getting manatee1 details from VMAPI');
            self.sdcadm.vmapi.getVm({
                uuid: uuid
            }, function (vmErr, obj) {
                if (vmErr) {
                    next(vmErr);
                    return;
                }
                sry = obj;
                next();
            });
        },

        function verify2ndManateeServer(_, next) {
            if (instances.length < 2) {
                next();
                return;
            }
            self.progress('Verifying 2nd manatee server');
            if (sry.server_uuid !== opts.servers[0]) {
                next(new errors.UsageError(util.format(
                        'The server specified for manatee1 \'%s\' is not ' +
                        'the same than the server where it has been created ' +
                        '\'%s\'', opts.servers[0], sry.server_uuid)));
                return;
            }
            next();
        },

        function verifyManateeVersion(_, next) {
            var parts = img.version.split('-');
            var curVer = parts[parts.length - 2];
            if (curVer < MIN_V2_TIMESTAMP) {
                var msg =
                    'Cannot setup ha-manateee ' +
                    'with a version built before than ' +
                    MIN_V2_TIMESTAMP + ' (current ' +
                    'version was built ' + curVer + ')';
                self.progress(msg);
                next(new errors.ValidationError(new Error(msg), 'sdcadm'));
                return;
            }

            if (curVer >= MIN_V21_TIMESTAMP) {
                manateeAdm21 = true;
            }

            next();
        },

        function confirm(_, next) {
            if (instances.length < 2) {
                changes.push({
                    image: img,
                    type: 'add-instance',
                    service: svc,
                    inst: {
                        type: 'vm',
                        alias: 'manatee1',
                        version: img.version,
                        service: 'manatee',
                        image: img.uuid,
                        server: opts.servers[0]
                    }
                });
            }
            changes.push({
                image: img,
                type: 'add-instance',
                service: svc,
                inst: {
                    type: 'vm',
                    alias: 'manatee2',
                    version: img.version,
                    service: 'manatee',
                    image: img.uuid,
                    server: opts.servers[1]
                }
            });
            p('');
            p('This command will make the following changes:');
            p('');
            var out = [];

            changes.forEach(function (c) {
                out.push(sprintf('Add instance "%s" in server %s',
                    c.inst.alias, c.inst.server));
            });
            out.push(sprintf('using image %s (%s@%s)',
                img.uuid, img.name, img.version));
            p(out.join('\n'));
            p('');
            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting ha-manatee');
                    cb();
                    return;
                }
                p('');
                next();
            });
        },

        function confirmDuplicatedServers(_, next) {
            if (!duplicatedServers || opts.yes) {
                next();
                return;
            }
            p('');
            p('You\'ve provided duplicated servers: %j.', opts.servers);
            p('');
            var msg = 'Are you sure you want to create more than one\n' +
                'instance into the same server?  [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting ha-manatee');
                    cb();
                    return;
                }
                p('');
                next();
            });
        },

        function getMorayVms(ctx, next) {
            self.progress('Getting SDC\'s moray vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'moray',
                state: 'running',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                ctx.morayVms = vms_;
                next();
            });
        },

        function getWorkflowVms(ctx, next) {
            self.progress('Getting SDC\'s workflow vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'workflow',
                state: 'running',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                ctx.wfVms = vms_;
                next();
            });
        },

        function getShardState(_, next) {
            self.progress('Getting manatee shard state');
            shared.getShardState({
                server: pri.server_uuid,
                manateeUUID: pri.uuid,
                log: self.log,
                hasManatee21: manateeAdm21
            }, function (err, st) {
                if (err) {
                    next(err);
                    return;
                }
                shardState = st;
                next();
            });
        },

        function create2ndManatee(_, next) {
            if (instances.length > 1) {
                self.progress('Skipping creation of 2nd manatee');
                next();
                return;
            }
            self.progress('Creating 2nd manatee through SAPI');
            self.sdcadm.sapi.createInstance(svc.uuid, {
                params: {
                    alias: 'manatee1',
                    server_uuid: opts.servers[0]
                },
                metadata: {}
            }, function (createErr, body) {
                if (createErr) {
                    next(createErr);
                    return;
                }
                newId = body.uuid;
                next();
            });
        },

        function waitForInstToBeUp(_, next) {
            if (instances.length > 1) {
                next();
                return;
            }
            self.progress('Waiting for the new manatee1 vm' +
                        ' (%s) to come up', newId);
            shared.waitForInstToBeUp({
                change: {
                    server: opts.servers[0],
                    type: 'create-instances',
                    service: 'manatee',
                    image: img,
                    inst: {
                        instance: newId,
                        zonename: newId,
                        alias: 'manatee1',
                        uuid: newId,
                        server: opts.servers[0],
                        service: 'manatee',
                        image: img.uuid,
                        version: img.version,
                        type: 'vm'
                    }
                },
                opts: {
                    progress: self.progress,
                    sdcadm: self.sdcadm,
                    log: self.log
                }
            }, next);
        },

        // We cannot disable manatee-sitter before we go ahead b/c we would not
        // be able to set ONWM using SAPI then:
        function setONWM(_, next) {
            if (shardState.oneNodeWriteMode) {
                self.progress('Disabling manatee0 ONE_NODE_WRITE_MODE (SAPI)');
                self.sdcadm.sapi.updateInstance(pri.uuid, {
                    action: 'delete',
                    metadata: {
                        ONE_NODE_WRITE_MODE: true
                    }
                }, function (err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    next();
                });
            } else {
                next();
            }
        },

        function callConfigAgent(_, next) {
            if (shardState.oneNodeWriteMode) {
                self.progress('Calling config-agent to rewrite manatee0 ' +
                        'config');
                common.callConfigAgentSync({
                    server: pri.server_uuid,
                    vm: pri.uuid,
                    log: self.log
                }, next);
            } else {
                next();
            }
        },

        function unfreezeState(_, next) {
            if (shardState.freeze) {
                self.progress('Unfreezing cluster state');
                manateeAdm(pri.uuid, 'unfreeze', next);
            } else {
                self.progress('Shard not frozen, skipping unfreeze step');
                next();
            }
        },

        function waitToRestart(_, next) {
            self.progress('Waiting 30 seconds to restart' +
                        ' manatee0 sitter');
            setTimeout(next, 30 * 1000);
        },

        function restartPrimarySitter(_, next) {
            self.progress('Restart SITTER on manatee0');
            restartSitter(pri.server_uuid, pri.uuid, next);
        },

        function waitToRestartAgain(_, next) {
            if (shardState.freeze || shardState.oneNodeWriteMode) {
                self.progress('Waiting 30 seconds to restart' +
                            ' manatee0 sitter once more');
                setTimeout(next, 30 * 1000);
            } else {
                next();
            }
        },

        function restartPrimarySitterAgain(_, next) {
            if (shardState.freeze || shardState.oneNodeWriteMode) {
                self.progress('Restart SITTER on manatee0 once more');
                restartSitter(pri.server_uuid, pri.uuid, next);
            } else {
                next();
            }

        },

        function waitForPostgres(_, next) {
            self.progress('Waiting for PostgreSQL to come up on manatee0');
            common.waitForPostgresUp({
                server: pri.server_uuid,
                vm: pri.uuid,
                log: self.log
            }, next);
        },

        // If 2nd manatee already exists, try to restart services there:
        function restart2ndSitter(_, next) {
            if (instances.length > 1) {
                self.progress('Restart SITTER on manatee1');
                restartSitter(sry.server_uuid, sry.uuid, next);
            } else {
                next();
            }
        },

        function waitFor2ndPostgres(_, next) {
            if (instances.length > 1) {
                self.progress('Waiting for PostgreSQL to come up on manatee1');
                common.waitForPostgresUp({
                    server: sry.server_uuid,
                    vm: sry.uuid,
                    log: self.log
                }, next);
            } else {
                next();
            }
        },

        function waitForManateeHA(_, next) {
            self.progress('Finally, waiting for manatee to reach HA');
            waitForHA(pri.uuid, manateeAdm21, next);
        },

        function restartMorays(ctx, next) {
            self.progress('Restarting moray services');
            vasync.forEachParallel({
                inputs: ctx.morayVms,
                func: function restartMoray(vm, nextVM) {
                    shared.restartRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: '*moray*',
                        log: self.log
                    }, nextVM);
                }
            }, next);
        },

        function wait4Morays(ctx, next) {
            self.progress('Waiting for moray services to be up');
            shared.wait4Morays({
                vms: ctx.morayVms,
                sdcadm: self.sdcadm
            }, next);
        },

        function restartWfApis(ctx, next) {
            self.progress('Restarting wf-api services');
            vasync.forEachParallel({
                inputs: ctx.wfVms,
                func: function restartWfApi(vm, nextVM) {
                    shared.restartRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: 'wf-api',
                        log: self.log
                    }, nextVM);
                }
            }, next);
        },

        function restartWfRunners(ctx, next) {
            self.progress('Restarting wf-runner services');
            vasync.forEachParallel({
                inputs: ctx.wfVms,
                func: function restartWfRunner(vm, nextVM) {
                    shared.restartRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: 'wf-runner',
                        log: self.log
                    }, nextVM);
                }
            }, next);
        },

        // Due to the proces above, moray and all the services connected to
        // moray, need to reconnect. Let's give them one minute:
        function waitForSvcsReconnecting(_, next) {
            if (instances.length === 1) {
                self.progress('Finished creation of 2nd manatee instance.\n' +
                   'Proceeding to create 3rd manatee.');
            }

            self.progress('Waiting for services to reconnect manatee');
            setTimeout(next, 60 * 1000);
        },
        shared.createInstance,
        shared.waitForInstToBeUp,
        function hupHermes(_, next) {
            svcadm.restartHermes({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        }
    ], arg: arg }, function (err) {
        // Log shard status and state in case of error:
        vasync.pipeline({
            funcs: [
                function recordState(_, next) {
                    if (!err) {
                        next();
                        return;
                    }

                    // If we are unable to find the primary, we cannot
                    // record shard state
                    if (!pri || !pri.server_uuid || !pri.uuid) {
                        next();
                        return;
                    }

                    shared.getShardState({
                        server: pri.server_uuid,
                        manateeUUID: pri.uuid,
                        log: self.log
                    }, function (err2, st) {
                        if (err2) {
                            self.log.error(err2);
                            next(err2);
                            return;
                        }
                        self.log.info(st, 'Shard state');
                        next();
                    });

                },
                function recordStatus(_, next) {
                    if (!err) {
                        next();
                        return;
                    }

                    // If we are unable to find the primary, we cannot
                    // record shard status
                    if (!pri || !pri.server_uuid || !pri.uuid) {
                        next();
                        return;
                    }

                    shared.getShardStatus({
                        server: pri.server_uuid,
                        manateeUUID: pri.uuid,
                        log: self.log
                    }, function (err2, st) {
                        if (err2) {
                            self.log.error(err2);
                            next(err2);
                            return;
                        }
                        self.log.info(st, 'Shard status');
                        next();
                    });
                }
            ]
        }, function (_pipeErr, results) {
            if (!err) {
                self.progress('manatee-ha finished.');
            }
            cb(err);
        });
    });
}

do_ha_manatee.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfString',
        help: 'The UUID for the target servers. Two values are required, ' +
            'one for sync manatee, another for async manatee.'
    }
];

do_ha_manatee.help = (
    'Create 2nd and 3rd manatee instances as the 1st required step for HA.\n' +
    '\n' +
    'When you have one manatee initially, you\'re in ONE_NODE_WRITE_MODE\n' +
    'which is a special mode that exists just for bootstrapping. To go\n' +
    'from this mode to a HA setup you\'ll need at least one more manatee.\n' +
    'Switching modes however is not quite as simple as just provisioning a\n' +
    'second one. This command attempts to move you from one instance to a\n' +
    'HA setup.\n' +
    '\n' +
    'After examining your setup and ensuring you\'re in the correct state\n' +
    'it will:\n' +
    '\n' +
    '- create a second manatee instance for you (with manatee-sitter' +
    ' disabled)\n' +
    '- disable the one_node_write mode on the first instance\n' +
    '- reboot the first manatee into multi-node mode\n' +
    '- reenable the sitter and reboot the second instance\n' +
    '- wait for manatee to return that it\'s synchronized\n' +
    '\n' +
    'After we\'ve gone through this, it\'ll create a 3rd manatee instance\n' +
    ' on the second server you specified to complete manatee ha setup.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} ha-manatee -s SERVER_UUID1 -s SERVER_UUID2\n' +
    '\n' +
    '{{options}}'
);



// --- exports

module.exports = {
    do_ha_manatee: do_ha_manatee
};
