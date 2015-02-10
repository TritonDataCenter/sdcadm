/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Collecting 'sdcadm post-setup ...' CLI commands.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;
var sprintf = require('extsprintf').sprintf;
var tabula = require('tabula');

var vasync = require('vasync');
var read = require('read');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;


var common = require('./common');
var svcadm = require('./svcadm');
var errors = require('./errors');
var DownloadImages = require('./procedures/download-images').DownloadImages;
var shared = require('./procedures/shared');
var post_setup_dev = require('./post-setup-dev');



//---- globals

var MIN_V2_TIMESTAMP = '20141218T222828Z';

//---- post-setup procedures

function Cloudapi() {}

Cloudapi.prototype.name = 'cloudapi';
Cloudapi.prototype.help = (
    'Create a first cloudapi instance.\n' +
    '\n' +
    'Initial setup of SmartDataCenter does not create a cloudapi instance.\n' +
    'This procedure will do that for you.\n'
);
Cloudapi.prototype.execute = function cExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');
    assert.func(cb, 'cb');

    var log = options.log;
    var sdcadm = options.sdcadm;
    var progress = options.progress;

    function onInstances(err, insts) {
        if (err) {
            return cb(err);
        }
        insts = insts.filter(function (svc) {
            if (svc.service === 'cloudapi') {
                return true;
            }
        });
        log.info({insts: insts}, '%d existing cloudapi insts', insts.length);
        if (insts.length === 1) {
            progress('Already have a cloudapi: vm %s (%s)',
                insts[0].instance, insts[0].alias);
            return cb();
        } else if (insts.length > 1) {
            progress('Already have %d cloudapi instances: vm %s (%s), ...',
                insts.length, insts[0].instance, insts[0].alias);
            return cb();
        }

        sdcadm.createCloudapiInstance({
            alias: 'cloudapi0',
            progress: progress
        }, cb);
    }

    sdcadm.getInstances({}, onInstances);
};

function CommonExternalNics() {}
CommonExternalNics.prototype.name = 'common-external-nics';
CommonExternalNics.prototype.help = (
    'Add external NICs to the adminui and imgapi zones.\n' +
    '\n' +
    'By default no SDC core zones are given external nics in initial\n' +
    'setup. Typically it is most useful to have those for the adminui\n' +
    'instance (to be able to access the operator portal in your browser)\n' +
    'and for the imgapi instance (to enable it to reach out to \n' +
    'updates.joyent.com and images.joyent.com for images). IMGAPI\n' +
    'instances are always firewalled such that only outbound connections\n' +
    'are allowed.\n'
);
CommonExternalNics.prototype.execute = function (options, cb) {
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');

    var sdcadm = options.sdcadm;

    sdcadm.setupCommonExternalNics({
        progress: options.progress
    }, cb);
};



//---- PostSetup CLI class

function PostSetupCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm post-setup',
        desc: 'Common post-setup procedures.\n' +
            '\n' +
            'The default setup of a SmartDataCenter headnode is somewhat\n' +
            'minimal. "Everything up to adminui." Practical usage of\n' +
            'SDC -- whether for production, development or testing --\n' +
            'involves a number of common post-setup steps. This command\n' +
            'attempts to capture many of those for convenience and\n' +
            'consistency.\n',
        helpOpts: {
            minHelpCol: 26
        }
    });
}
util.inherits(PostSetupCLI, Cmdln);

PostSetupCLI.prototype.init = function init(opts, args, cb) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


PostSetupCLI.prototype.do_cloudapi =
function do_cloudapi(subcmd, opts, args, cb) {
    var self = this;
    var proc = new Cloudapi();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'cloudapi'}, true),
            progress: self.top.progress
        }, cb);
};
PostSetupCLI.prototype.do_cloudapi.help = (
    Cloudapi.prototype.help +
    '\n' +
    'Usage:\n' +
    '     {{name}} cloudapi\n'
);

PostSetupCLI.prototype.do_common_external_nics =
function do_common_external_nics(subcmd, opts, args, cb) {
    var proc = new CommonExternalNics();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'common-external-nics'}, true),
            progress: this.progress
        }, cb);
};
PostSetupCLI.prototype.do_common_external_nics.help = (
    CommonExternalNics.prototype.help +
    '\n' +
    'Usage:\n' +
    '     {{name}} common-external-nics\n'
);


/**
 * Add the 'zookeeper' service to the 'sdc' app in SAPI and create the given
 * number of instances (either 3 or 5) into the given servers (UUIDs). The
 * first instance will be created into the Headnode. Therefore, we only need
 * (n - 1) server uuids, where 'n' is the number of zookeeper desired
 * instances.
 *
 * The idea is that we should be able to re-run this command as many times as
 * required, and it should be able to continue from wherever it exited during
 * the previous execution: either adding the service to SAPI, creating the
 * first or any of the following instances, reconfiguring the zookeeper
 * instances and reconfiguring the associated services.
 */
PostSetupCLI.prototype.do_zookeeper =
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

    var img, app, svc, instances, history, vms;
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
        function getSdcApp(_, next) {
            self.progress('Getting SDC application details from SAPI');
            self.sdcadm.sapi.listApplications({
                name: 'sdc'
            }, function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }
                app = apps[0];
                return next();
            });
        },

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
                if (servers.length !== servers_.length) {
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
                            alias: change.inst.alias,
                            owner_uuid: self.sdcadm.config.ufds_admin_uuid
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
            history.error = err;
        } else {
            self.progress('Zookeeper setup finished.');
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
};

PostSetupCLI.prototype.do_zookeeper.options = [
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

PostSetupCLI.prototype.do_zookeeper.help = (
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


PostSetupCLI.prototype.do_ha_manatee =
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
                format('-n %s', server),
                format('/usr/sbin/zlogin %s ', zuuid) +
                format('\'json %s < ' +
                        '/opt/smartdc/manatee/etc/sitter.json\'', flag)
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
                format('-n %s ', server),
                format('/usr/sbin/zlogin %s ', zone) +
                '\'/opt/local/bin/psql -U postgres -t -A -c ' +
                '"SELECT NOW() AS when;"\''
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
        self.log.trace({
            server: server,
            zone: zone
        }, 'Restarting manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('/usr/sbin/svcadm -z %s restart manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });
    }


    function disableSitter(server, zone, callback) {
        self.log.trace({
            server: server,
            zone: zone
        }, 'Disabling manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('/usr/sbin/svcadm -z %s disable manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });
    }


    function enableSitter(server, zone, callback) {
        self.log.trace({
            server: server,
            zone: zone
        }, 'Restarting manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('/usr/sbin/svcadm -z %s enable -s manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });

    }

    var app, svc, inst, vm, img, history;
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
                if (servers.length !== servers_.length) {
                    return cb(new errors.UsageError(
                        'Must specify 2 existing servers'));
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

        function getSdcApp(_, next) {
            self.progress('Getting SDC application details from SAPI');
            self.sdcadm.sapi.listApplications({ name: 'sdc' },
            function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }

                app = apps[0];
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

                if (insts.length > 1) {
                    return next(new errors.SDCClientError(new Error(format(
                        'You already have %s manatee instances.\n',
                        insts.length) + 'ha-manatee only has sense' +
                        'when you have a singel manatee instance'), 'sapi'));
                }

                inst = insts[0];
                return next();
            });
        },

        function getPrimaryManateeVm(_, next) {
            self.progress('Getting primary manatee details from VMAPI');
            self.sdcadm.vmapi.getVm({uuid: inst.uuid}, function (vmErr, obj) {
                if (vmErr) {
                    return next(vmErr);
                }
                vm = obj;
                return next();
            });
        },

        // This is for merely informative purposes and in order to add our
        // changes to history:
        function getImage(_, next) {
            self.sdcadm.imgapi.getImage(vm.image_uuid, {}, function (err, im) {
                if (err) {
                    next(err);
                } else {
                    img = im;
                    next();
                }
            });
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

        function create2ndManatee(_, next) {
            self.progress('Creating 2nd manatee through SAPI');
            self.sdcadm.sapi.createInstance(svc.uuid, {
                params: {
                    alias: 'manatee1',
                    server_uuid: opts.servers[0],
                    owner_uuid: self.sdcadm.config.ufds_admin_uuid
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
            self.progress('Waiting 60 seconds for the new manatee1 vm' +
                        ' (%s) to come up', newId);
            // This is the same lame thing than for incr-upgrades
            // TODO: improve this to use instance "up" checks from TOOLS-551
            setTimeout(next, 60 * 1000);
        },

        // We cannot disable manatee-sitter before we go ahead b/c we would not
        // be able to set ONWM using SAPI then:
        function setONWM(_, next) {
            self.progress('Disabling ONE_NODE_WRITE_MODE on manatee0 (SAPI)');
            self.sdcadm.sapi.updateInstance(vm.uuid, {
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
        },

        function unfreezeState(_, next) {
            self.progress('Unfreezing cluster state');
            manateeAdm(vm.uuid, 'unfreeze', function (err, stdou, stder) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        },

        function restartPrimarySitter(_, next) {
            self.progress('Restart SITTER on manatee0');
            restartSitter(vm.server_uuid, vm.uuid, next);
        },

        function waitToRestart(_, next) {
            self.progress('Waiting 30 seconds to restart' +
                        ' manatee0 sitter once more');
            setTimeout(next, 30 * 1000);
        },

        function restartPrimarySitterAgain(_, next) {
            self.progress('Restart SITTER on manatee0 once more');
            restartSitter(vm.server_uuid, vm.uuid, next);
        },

        function waitForPostgres(_, next) {
            self.progress('Waiting for PostgreSQL to come up on manatee0');
            waitForPostgresUp(vm.server_uuid, vm.uuid, next);
        },

        function waitForManateeHA(_, next) {
            self.progress('Finally, waiting for manatee to reach HA');
            waitForHA(vm.uuid, next);
        },

        // Due to the proces above, moray and all the services connected to
        // moray, need to reconnect. Let's give them one minute:
        function waitForSvcsReconnecting(_, next) {
            self.progress('Finished creation of 2nd manatee instance.\n' +
                'Proceeding to create 3rd manatee.');

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
        // Add error to history in case the update execution failed:
        if (err) {
            if (!history) {
                return cb(err);
            }
            history.error = err;
        } else {
            self.progress('manatee-ha finished.');
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
};

PostSetupCLI.prototype.do_ha_manatee.options = [
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
PostSetupCLI.prototype.do_ha_manatee.help = (
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
    '     {{name}} ha-manatee\n' +
    '\n' +
    '{{options}}'
);


PostSetupCLI.prototype.do_dev_headnode_prov =
    post_setup_dev.HeadnodeProvCLI;


//---- exports

module.exports = {
    PostSetupCLI: PostSetupCLI
};
