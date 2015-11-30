/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup ha-manatee'
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var cp = require('child_process');
var spawn = cp.spawn;
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var common = require('../common');
var svcadm = require('../svcadm');
var errors = require('../errors');
var shared = require('../procedures/shared');



//---- globals

var MIN_V2_TIMESTAMP = '20141218T222828Z';


//---- CLI

function do_ha_manatee(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (!opts.servers || !opts.servers.length ||
            opts.servers.length !== 2) {
        return cb(new errors.UsageError(
            'Must specify 2 target servers'));
    }


    function waitForDisabled(server, zuuid, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForDisabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                '-n',
                server,
                /* JSSTYLED */
                format('/usr/sbin/zlogin %s "json %s < /opt/smartdc/manatee/etc/sitter.json"', zuuid, flag)
            ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    callback(err);
                } else {
                    var res = JSON.parse(stdout.trim());
                    counter += 1;
                    if (res[0].result.stdout.trim() === 'false') {
                        callback();
                    } else {
                        if (counter < limit) {
                            return setTimeout(_waitForDisabled, 5000);
                        } else {
                            return callback(format(
                                'Timeout (60s) waiting for config flag' +
                                ' %s to be disabled', flag));
                        }

                    }
                }
            });
        }
        _waitForDisabled();
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
        }, function (err, stdout, stderr) {
            return callback(err, stdout, stderr);
        });
    }


    function getShardStatus(manateeUUID, callback) {
        function statusCb(err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            var manateeShard = JSON.parse(stdout);
            return callback(null, manateeShard);
        }
        manateeAdm(manateeUUID, 'status', statusCb);
    }


    function waitForHA(localManateeUUID, callback) {
        var counter = 0;
        var limit = 60;
        function _waitForHA() {
            getShardStatus(localManateeUUID, function (err, o) {
                if (err) {
                    return callback(err);
                }
                if (o.sdc.primary && o.sdc.sync && o.sdc.primary.repl &&
                    o.sdc.primary.repl.sync_state === 'sync') {
                    return callback();
                } else {
                    if (counter < limit) {
                        return setTimeout(_waitForHA, 5000);
                    } else {
                        return callback('Timeout (5m) waiting for HA');
                    }
                }
            });
        }
        _waitForHA();
    }


    function waitForPostgresUp(server, zone, callback) {
        var counter = 0;
        var limit = 36;
        function _waitForPostgresUp() {
            var arg1 = [
                '-n',
                server,
                /* JSSTYLED */
                format('/usr/sbin/zlogin %s "/opt/local/bin/psql -U postgres -t -A -c \'SELECT NOW() AS when;\'"', zone)
            ];

            var child = spawn('/opt/smartdc/bin/sdc-oneachnode', arg1);
            var stdout = [];
            var stderr = [];
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function (so) {
                stdout.push(so);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function (se) {
                stderr.push(se);
            });

            child.on('close', function vmadmDone(code, signal) {
                stdout = stdout.join('');
                stderr = stderr.join('');
                self.log.debug({
                    code: code,
                    signal: signal,
                    stdout: stdout,
                    stderr: stderr
                }, 'Ping PostgreSQL');
                if ((code || signal)) {
                    if (counter < limit) {
                        return setTimeout(_waitForPostgresUp, 5000);
                    } else {
                        return callback('Timeout (60s) waiting for Postgres');
                    }
                } else {
                    return callback();
                }
            });
        }
        _waitForPostgresUp();
    }


    function restartSitter(server, zone, callback) {
        shared.restartRemoteSvc({
            server: server,
            zone: zone,
            fmri: 'manatee-sitter',
            log: self.log
        }, callback);
    }


    function disableSitter(server, zone, callback) {
        shared.disableRemoteSvc({
            server: server,
            zone: zone,
            fmri: 'manatee-sitter',
            log: self.log
        }, callback);
    }


    function enableSitter(server, zone, callback) {
        shared.enableRemoteSvc({
            server: server,
            zone: zone,
            fmri: 'manatee-sitter',
            log: self.log
        }, callback);
    }


    function callConfigAgentSync(server, zone, callback) {
        self.log.trace({
            server: server,
            zone: zone
        }, 'Calling config-agent sync (sdc-oneachnode)');

        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-j',
            '-n',
            server,
            /* JSSTYLED */
            format('/usr/sbin/zlogin %s "/opt/smartdc/config-agent/build/node/bin/node /opt/smartdc/config-agent/agent.js -f /opt/smartdc/config-agent/etc/config.json -s"', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            var res = JSON.parse(stdout);
            if (!res.length || !res[0].result || !res[0].result.stdout) {
                self.log.error({res: res}, 'config agent result');
                return callback('Unexpected config agent output' +
                        ' (sdc-oneachnode)');
            }
            var out = res[0].result.stdout.trim();
            self.log.trace(out, 'Config agent output');
            return callback(null, out);
        });
    }


    var app = self.sdcadm.sdc;
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
    // History, and the changes will add to history, depending on how many
    // instances we have when runing the process:
    var history;
    var changes = [];
    var newId;

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
        function checkTargetServer(_, next) {
            self.progress('Verifying target severs "%j" exist', opts.servers);
            self.sdcadm.cnapi.listServers(function (sErr, servers_) {
                if (sErr) {
                    return next(sErr);
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
                    var msg = 'Either you haven\'t provided ' + opts.members +
                        ' valid Server UUIDs, or the ones you\'ve provided ' +
                        'do not belong to servers setup in CNAPI.\nPlease ' +
                        'provide the UUIDs for ' + opts.members +
                        ' setup servers.';
                    return next(new errors.UsageError(msg));
                }
                return next();
            });
        },

        function getManateeServices(_, next) {
            self.progress('Getting SDC\'s manatee details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'manatee',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "manatee"'), 'sapi'));
                }
                svc = svcs[0];
                arg.change.service = svc;
                return next();
            });
        },

        function getManateeInstances(_, next) {
            self.progress('Getting SDC\'s manatee instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }

                if (!insts.length) {
                    return next(new errors.SDCClientError(new Error(
                        'Unable to find first manatee instance'), 'sapi'));
                }

                if (insts.length > 2) {
                    return next(new errors.UsageError(
                        'You already have ' + insts.length +
                        ' manatee instances.\n' +
                        '"sdcadm post-setup ha-manatee" only has sense ' +
                        'when you have a single manatee instance\n' +
                        'or are trying to recover from a previous failure' +
                        'where the creation of the 2nd and/or \n' +
                        '3rd instance failed'));
                }

                instances = insts;
                return next();
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
                    return next(vmErr);
                }
                pri = obj;
                return next();
            });
        },

        // This is for merely informative purposes and in order to add our
        // changes to history:
        function getImage(_, next) {
            self.sdcadm.imgapi.getImage(pri.image_uuid, {}, function (err, im) {
                if (err) {
                    next(err);
                } else {
                    img = im;
                    next();
                }
            });
        },

        function getSecondaryManateeVm(_, next) {
            if (instances.length < 2) {
                return next();
            }
            var uuid = instances.filter(function (i) {
                return (i.params.alias === 'manatee1');
            })[0].uuid;
            self.progress('Getting manatee1 details from VMAPI');
            self.sdcadm.vmapi.getVm({
                uuid: uuid
            }, function (vmErr, obj) {
                if (vmErr) {
                    return next(vmErr);
                }
                sry = obj;
                return next();
            });
        },

        function verify2ndManateeServer(_, next) {
            if (instances.length < 2) {
                return next();
            }
            self.progress('Verifying 2nd manatee server');
            if (sry.server_uuid !== opts.servers[0]) {
                return next(new errors.UsageError(
                        'The server specified for manatee1 \'%s\' is not ' +
                        'the same than the server where it has been created ' +
                        '\'%s\'', opts.servers[0], sry.server_uuid));
            }
            return next();
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
                return next(new errors.ValidationError(new Error(msg),
                    'sdcadm'));
            }
            return next();
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
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting ha-manatee');
                    return cb();
                }
                p('');
                next();
            });
        },

        function confirmDuplicatedServers(_, next) {
            if (!duplicatedServers || opts.yes) {
                return next();
            }
            p('');
            p('You\'ve provided duplicated servers: %j.', opts.servers);
            p('');
            var msg = 'Are you sure you want to create more than one\n' +
                'instance into the same server?  [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting ha-manatee');
                    return cb();
                }
                p('');
                next();
            });
        },

        // Wait until after prompt Yes/No:
        function saveChangesToHistory(_, next) {
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                history = hst;
                return next();
            });
        },

        function getShardState(_, next) {
            self.progress('Getting manatee shard state');
            shared.getShardState({
                server: pri.server_uuid,
                manateeUUID: pri.uuid,
                log: self.log
            }, function (err, st) {
                if (err) {
                    return next(err);
                }
                shardState = st;
                return next();
            });
        },

        function create2ndManatee(_, next) {
            if (instances.length > 1) {
                self.progress('Skipping creation of 2nd manatee');
                return next();
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
                    return next(createErr);
                }
                newId = body.uuid;
                return next();
            });
        },

        function waitForInstToBeUp(_, next) {
            if (instances.length > 1) {
                return next();
            }
            self.progress('Waiting 60 seconds for the new manatee1 vm' +
                        ' (%s) to come up', newId);
            // This is the same lame thing than for incr-upgrades
            // TODO: improve this to use instance "up" checks from TOOLS-551
            setTimeout(next, 60 * 1000);
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
                        return next(err);
                    }
                    return next();
                });
            } else {
                return next();
            }
        },

        function callConfigAgent(_, next) {
            if (shardState.oneNodeWriteMode) {
                self.progress('Calling config-agent to rewrite manatee0 ' +
                        'config');
                callConfigAgentSync(pri.server_uuid, pri.uuid,
                        function (err, out) {
                    if (err) {
                        return next(err);
                    }
                    return next();
                });
            } else {
                return next();
            }
        },

        function unfreezeState(_, next) {
            if (shardState.freeze) {
                self.progress('Unfreezing cluster state');
                manateeAdm(pri.uuid, 'unfreeze', function (err, stdou, stder) {
                    if (err) {
                        return next(err);
                    }
                    return next();
                });
            } else {
                self.progress('Shard not frozen, skipping unfreeze step');
                return next();
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
                return next();
            }
        },

        function restartPrimarySitterAgain(_, next) {
            if (shardState.freeze || shardState.oneNodeWriteMode) {
                self.progress('Restart SITTER on manatee0 once more');
                restartSitter(pri.server_uuid, pri.uuid, next);
            } else {
                return next();
            }

        },

        function waitForPostgres(_, next) {
            self.progress('Waiting for PostgreSQL to come up on manatee0');
            waitForPostgresUp(pri.server_uuid, pri.uuid, next);
        },

        // If 2nd manatee already exists, try to restart services there:
        function restart2ndSitter(_, next) {
            if (instances.length > 1) {
                self.progress('Restart SITTER on manatee1');
                restartSitter(sry.server_uuid, sry.uuid, next);
            } else {
                return next();
            }
        },

        function waitFor2ndPostgres(_, next) {
            if (instances.length > 1) {
                self.progress('Waiting for PostgreSQL to come up on manatee1');
                waitForPostgresUp(sry.server_uuid, sry.uuid, next);
            } else {
                return next();
            }
        },

        function waitForManateeHA(_, next) {
            self.progress('Finally, waiting for manatee to reach HA');
            waitForHA(pri.uuid, next);
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
                        return next();
                    }

                    // If we are unable to find the primary, we cannot
                    // record shard state
                    if (!pri || !pri.server_uuid || !pri.uuid) {
                        return next();
                    }

                    shared.getShardState({
                        server: pri.server_uuid,
                        manateeUUID: pri.uuid,
                        log: self.log
                    }, function (err2, st) {
                        if (err2) {
                            self.log.error(err2);
                            return next(err2);
                        }
                        self.log.info(st, 'Shard state');
                        return next();
                    });

                },
                function recordStatus(_, next) {
                    if (!err) {
                        return next();
                    }

                    // If we are unable to find the primary, we cannot
                    // record shard status
                    if (!pri || !pri.server_uuid || !pri.uuid) {
                        return next();
                    }

                    shared.getShardStatus({
                        server: pri.server_uuid,
                        manateeUUID: pri.uuid,
                        log: self.log
                    }, function (err2, st) {
                        if (err2) {
                            self.log.error(err2);
                            return next(err2);
                        }
                        self.log.info(st, 'Shard status');
                        return next();
                    });
                }
            ]
        }, function (er, results) {
            // Add error to history in case the update execution failed:
            if (err) {
                if (!history) {
                    self.log.warn('History not set for post-setup ha-manatee');
                    return cb(err);
                }
                history.error = err;
            } else {
                self.progress('manatee-ha finished.');
            }
            if (!history) {
                self.log.warn('History not set for post-setup ha-manatee');
                return cb();
            }
            history.changes = changes;
            // No need to add `history.finished` here, History instance will do
            self.sdcadm.history.updateHistory(history, function (err2, hist2) {
                if (err) {
                    cb(err);
                } else if (err2) {
                    cb(err2);
                } else {
                    cb();
                }
            });
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



//---- exports

module.exports = {
    do_ha_manatee: do_ha_manatee
};
