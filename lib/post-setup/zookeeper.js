/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup zookeeper'
 */

var p = console.log;
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var shared = require('../procedures/shared');
var svcadm = require('../svcadm');



// ---- CLI

/**
 * Setup more zookeeper nodes. In SDC, zookeeper lives in the 'binder' zones.
 * Typically this command is used to move from the default headnode setup
 * of a single binder instance (the 'binder0' zone) up to a cluster of three
 * (or perhaps five).
 */
function do_zookeeper(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (opts.members !== 2 && opts.members !== 4) {
        return cb(new errors.UsageError(
                    'Invalid number of ZK cluster members: ' +
                    opts.members));
    }

    if (!opts.servers || !opts.servers.length ||
            opts.servers.length < (opts.members - 1)) {
        return cb(new errors.UsageError(
                    'Must specify ' +
                    (opts.members - 1) + ' servers'));

    }

    var app = self.sdcadm.sdc;
    var img, svc, instances, history, vms;
    var nextId = 0;
    var servers = [];
    var changes = []; // used by history functions
    var arg = {}; // to pass to shared.js functions
    var HA_ZK_JSON = [];
    var moraySvc, manateeSvc;
    var morayVms, manateeVms;
    var shard;
    var leaderIP;
    var duplicatedServers = false;

    vasync.pipeline({arg: arg, funcs: [
        function getBinderSvc(_, next) {
            self.progress('Getting SDC\'s binder details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'binder',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (svcs.length) {
                    svc = svcs[0];
                }
                return next();
            });
        },

        // XXX vestigial?
        shared.getUserScript, // sets `arg.userScript`.

        function getBinderInstances(_, next) {
            if (!svc) {
                return next();
            }
            self.progress('Getting SDC\'s binder instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }
                instances = insts;
                return next();
            });
        },

        function getBinderVms(_, next) {
            self.progress('Getting SDC\'s binder vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'binder',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                vms = vms_;
                return next();
            });
        },


        function checkTargetServers(_, next) {
            if (instances && instances.length === (opts.members + 1)) {
                return next();
            }
            self.progress('Verifying target severs "%j" exist', opts.servers);
            self.sdcadm.cnapi.listServers(function (sErr, servers_) {
                if (sErr) {
                    return next(sErr);
                }
                servers = servers_.filter(function (s) {
                    return (opts.servers.indexOf(s.uuid) !== -1);
                });
                if (servers.length !== opts.servers.length) {
                    return cb(new errors.UsageError(
                        'Must specify ' + opts.members + ' existing servers'));
                }
                // Check if any of the provided servers is duplicate:
                var unique = opts.servers.filter(function (item, pos, ary) {
                    return (ary.indexOf(item) === pos);
                });
                if (unique.length !== opts.servers.length) {
                    duplicatedServers = true;
                }
                return next();
            });
        },

        function getNextInstanceId(_, next) {
            if (!instances || instances.length === (opts.members + 1)) {
                return next();
            }
            self.progress('Calculating next binder instance alias');
            nextId = instances.map(function (inst) {
                return Number(inst.params.alias.replace('binder', ''));
            }).sort().pop();
            nextId = nextId + 1;
            return next();
        },

        // This is for merely informative purposes and in order to add our
        // changes to history:
        function getImage(_, next) {
            self.sdcadm.imgapi.getImage(vms[0].image_uuid, {
            }, function (err, im) {
                if (err) {
                    next(err);
                } else {
                    img = im;
                    next();
                }
            });
        },

        function instancesToBeCreated(_, next) {
            if (instances && instances.length === (opts.members + 1)) {
                return next();
            }
            self.progress('Determining binder instances to be created');
            var i;
            for (i = nextId; i < (opts.members + 1); i += 1) {
                var change = {
                    image: img,
                    type: 'add-instance',
                    service: svc,
                    inst: {
                        type: 'vm',
                        alias: 'binder' + i,
                        version: img.version,
                        service: 'binder',
                        image: img.uuid,
                        // The binder's zk has zk_id of 1, next one needs to
                        // begin at 2, and so forth:
                        zk_id: 2 + i
                    }
                };
                change.inst.server = opts.servers[(i - 1)];
                changes.push(change);
            }
            return next();
        },

        function getMorayService(_, next) {
            self.progress('Getting SDC\'s moray details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'moray',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "moray"'), 'sapi'));
                }
                moraySvc = svcs[0];
                return next();
            });
        },

        function getMorayVms(_, next) {
            self.progress('Getting SDC\'s moray vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'moray',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                morayVms = vms_;
                return next();
            });
        },

        function getManateeService(_, next) {
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
                manateeSvc = svcs[0];
                return next();
            });
        },

        function getManateeVms(_, next) {
            self.progress('Getting SDC\'s manatees vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'manatee',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                manateeVms = vms_;
                return next();
            });
        },

        function getShard(_, next) {
            self.progress('Getting manatee shard status');
            var vm = manateeVms[0];

            shared.getShardStatus({
                server: vm.server_uuid,
                manateeUUID: vm.uuid,
                log: self.sdcadm.log
            }, function (err, st) {
                if (err) {
                    return next(err);
                }
                shard = st;
                // Also set server uuid for each one of the manatees on the
                // shard to simplify next steps:
                // XXX what if >3 manatees?
                manateeVms.forEach(function (v) {
                    if (shard.sdc.primary.zoneId === v.uuid) {
                        shard.sdc.primary.server = v.server_uuid;
                    } else if (shard.sdc.sync &&
                        shard.sdc.sync.zoneId === v.uuid) {
                        shard.sdc.sync.server = v.server_uuid;
                    } else if (shard.sdc.async &&
                        shard.sdc.async.zoneId === v.uuid) {
                        shard.sdc.async.server = v.server_uuid;
                    }
                });
                return next();
            });
        },

        function confirm(_, next) {
            if (changes.length === 0) {
                return next();
            }
            p('');
            p('This command will make the following changes:');
            p('');
            var out = [];

            changes.forEach(function (c) {
                out.push(sprintf('Add instance "%s" in server %s',
                    c.inst.alias, c.inst.server));
            });
            p(out.join('\n'));
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting zookeeper setup');
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
                    p('Aborting zookeeper setup');
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

        function createBinderInstances(_, next) {
            if (instances && instances.length === (opts.members + 1)) {
                return next();
            }

            vasync.forEachPipeline({
                inputs: changes,
                func: function createBinderInstance(change, next_) {
                    self.progress('Creating "%s" instance', change.inst.alias);
                    var instOpts = {
                        params: {
                            alias: change.inst.alias
                        },
                        metadata: {
                            ZK_ID: String(change.inst.zk_id)
                        }
                    };

                    if (change.inst.server) {
                        instOpts.params.server_uuid = change.inst.server;
                    }

                    self.sdcadm.sapi.createInstance(svc.uuid, instOpts,
                            function (err, inst_) {
                        if (err) {
                            return next_(
                                new errors.SDCClientError(err, 'sapi'));
                        }
                        self.progress('Instance "%s" (%s) created',
                            inst_.uuid, inst_.params.alias);
                        return next_();
                    });
                }
            }, function _resCb(pipErr, results) {
                if (pipErr) {
                    return next(pipErr);
                }
                return next();
            });
        },

        function hupHermes(_, next) {
            svcadm.restartHermes({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        function getBinderInstancesAfterCreation(_, next) {
            if (instances && instances.length === opts.members) {
                return next();
            }
            self.progress('Getting SDC\'s binder instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }
                instances = insts;
                return next();
            });
        },

        function getBinderVmsAfterCreation(_, next) {
            self.progress('Getting SDC\'s binder vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'binder',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                vms = vms_;
                return next();
            });
        },

        function prepareClusterPayload(_, next) {
            vms.forEach(function (vm) {
                var instance = instances.filter(function (i) {
                    return (i.uuid === vm.uuid);
                })[0];

                HA_ZK_JSON.push({
                    host: vm.nics[0].ip,
                    port: 2181,
                    num: Number(instance.metadata.ZK_ID)
                });
            });

            // Set a value for special property "last" for just the final
            // element of the collection
            HA_ZK_JSON[HA_ZK_JSON.length - 1].last = true;
            return next();
        },

        function cfgBinderService(_, next) {
            self.progress('Updating Binder service config in SAPI');
            self.sdcadm.sapi.updateApplication(app.uuid, {
                metadata: {
                    ZK_SERVERS: HA_ZK_JSON
                }
            }, function (upErr) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function waitForZkClusterOk(_, next) {
            self.progress('Waiting for ZK cluster to reach a steady state');
            var ips = vms.map(function (vm) {
                return (vm.nics[0].ip);
            });

            shared.wait4ZkOk({
                ips: ips,
                log: self.sdcadm.log
            }, next);
        },

        function checkAllInstancesJoinedZkCluster(_, next) {
            self.progress('Waiting for binder instances to join ZK cluster');
            var ips = vms.map(function (vm) {
                return (vm.nics[0].ip);
            });

            shared.wait4ZkCluster({
                ips: ips,
                log: self.sdcadm.log
            }, next);
        },

        // Now that we've added the binder, wouldn't it be the leader always?:
        function getZkLeaderIP(_, next) {
            self.progress('Getting ZK leader IP');
            var ips = vms.map(function (vm) {
                return (vm.nics[0].ip);
            });

            shared.getZkLeaderIP({
                ips: ips,
                log: self.sdcadm.log
            }, function (err, ip) {
                if (err) {
                    return next(err);
                }
                leaderIP = ip;
                return next();
            });
        },

        function cfgMoraySvc(_, next) {
            self.progress('Updating Moray service config in SAPI');
            self.sdcadm.sapi.updateService(moraySvc.uuid, {
                metadata: {
                    ZK_HA_SERVERS: HA_ZK_JSON
                }
            }, function (upErr) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function cfgManateeSvc(_, next) {
            self.progress('Updating Manatee service config in SAPI');
            self.sdcadm.sapi.updateService(manateeSvc.uuid, {
                metadata: {
                    ZK_HA_SERVERS: HA_ZK_JSON
                }
            }, function (upErr) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function disableManatee(_, next) {
            shared.disableManateeSitter({
                progress: self.progress,
                log: self.sdcadm.log,
                shard: shard
            }, next);
        },

        function enableManatee(_, next) {
            shared.enableManateeSitter({
                progress: self.progress,
                log: self.sdcadm.log,
                leaderIP: leaderIP,
                shard: shard
            }, next);
        },

        function restartMorays(_, next) {
            self.progress('Restarting moray services');
            vasync.forEachParallel({
                inputs: morayVms,
                func: function restartMoray(vm, next_) {
                    shared.restartRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: '*moray-202*',
                        log: self.sdcadm.log
                    }, next_);
                }
            }, function (morErr, morRes) {
                if (morRes) {
                    return next(morErr);
                }
                return next();
            });
        },

        function wait4Morays(_, next) {
            self.progress('Waiting (2mins) for moray services to be up');
            setTimeout(next, 120 * 1000);
        }

    ]}, function (err) {
        // Add error to history in case the update execution failed:
        if (err) {
            if (!history) {
                self.log.warn('History not set for post-setup zookeeper');
                return cb(err);
            }
            history.error = err;
        } else {
            self.progress('Zookeeper setup finished.');
        }
        if (!history) {
            self.log.warn('History not set for post-setup zookeeper');
            return cb();
        }
        history.changes = changes;
        // No need to add `history.finished` here, History instance will handle
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
}

do_zookeeper.options = [
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
        help: 'UUID for the target servers. At least m are required.'
    },
    {
        names: ['members', 'm'],
        type: 'integer',
        'default': 2,
        help: 'Number of instances to create (2 or 4). Default: 2'
    }

];

do_zookeeper.help = (
    'Create a zookeeper cluster, known as an ensemble, using Headnode\'s\n' +
    'binder as the first member and leader of the cluster.\n' +
    '\n' +
    'Given that the existing binder instance will be included into the\n' +
    'ensemble, and we need an odd number of machines for better cluster\n' +
    'reliability, we need to specify an additional number of new instances\n' +
    'to be created, either 2 or 4, in order to complete a total of 3 or 5\n' +
    'instances.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} zookeeper\n' +
    '\n' +
    '{{options}}'
);




//---- exports

module.exports = {
    do_zookeeper: do_zookeeper
};
