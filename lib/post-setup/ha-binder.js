/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup ha-binder'.
 */

var p = console.log;
var util = require('util');
var path = require('path');
var fs = require('fs');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');
var mkdirp = require('mkdirp');

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
 *
 * Zookeeper data backup:
 *
 * Note that in order to make possible an eventual recover of initial data,
 * we're creating backups of the zookeeper data directory at the initial binder
 * VM into /var/sdcadm/ha-binder/zookeeper-TIMESTAMP.tgz.
 *
 * In theory, (at least that's what zookeeper documentation says into the admin
 * manual: http://zookeeper.apache.org/doc/r3.4.3/zookeeperAdmin.html
 * #sc_dataFileManagement), any zookeeper data directory could be used by any
 * zookeeper instance into any VM to rebuild the status of the system by
 * replying the transaction log.
 *
 * In case of a failure of this process, the backup can be restored into the
 * initial binder VM, on the place expected by the zookeeper service; that is:
 * /zookeeper/zookeeper. The tarball will be extracted to a directory called
 * 'version-2'.
 *
 * (Note this may change with future zookeeper versions or with custom
 * zookeeper configurations).
 */
function do_ha_binder(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (subcmd === 'zookeeper') {
        self.progress('Warning: `sdcadm post-setup zookeeper` is deprecated.' +
            '\n' + common.indent(
                'Please use `sdcadm post-setup ha-binder` instead.',
                '         '));
    }

    if (opts.members !== 2 && opts.members !== 4) {
        return cb(new errors.UsageError(
                    'Invalid number of binder cluster members: ' +
                    opts.members));
    }

    if (!opts.servers || !opts.servers.length ||
            opts.servers.length < (opts.members - 1)) {
        return cb(new errors.UsageError(
                    'Must specify ' +
                    (opts.members - 1) + ' servers'));

    }

    var app = self.sdcadm.sdc;
    var img, svc, instances, history;
    var vms;
    var oldVms;
    var newVms = [];
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
    var start = new Date();
    var wrkDir;
    var stamp;

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
                oldVms = vms_.map(function (vm) {
                    return vm.uuid;
                });
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

                var msg = 'Either you haven\'t provided ' + opts.members +
                    ' valid Server UUIDs, or the ones you\'ve provided ' +
                    'do not belong to servers setup in CNAPI.\nPlease ' +
                    'provide the UUIDs for ' + opts.members +
                    ' setup servers.';

                servers = servers_.filter(function (s) {
                    return (opts.servers.indexOf(s.uuid) !== -1);
                });

                // Check if the minimum required number of servers have been
                // provided (even duplicates):
                if (opts.servers.length !== opts.members) {
                    return next(new errors.UsageError(msg));
                }

                // Check if any of the provided servers is duplicate:
                var unique = opts.servers.filter(function (item, pos, ary) {
                    return (ary.indexOf(item) === pos);
                });

                if (unique.length !== opts.servers.length) {
                    duplicatedServers = true;
                }

                if (unique.length !== servers.length) {
                    return next(new errors.UsageError(msg));
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
                    p('Aborting ha-binder setup');
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
                    p('Aborting ha-binder setup');
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

        function createWrkDir(_, next) {
            stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth() + 1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds());
            wrkDir = '/var/sdcadm/ha-binder/' + stamp;
            self.progress('Create work dir: ' + wrkDir);

            mkdirp(wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function freezeManatee(_, next) {
            self.progress('Freezing manatee shard');
            common.manateeFreeze({
                vm: manateeVms[0].uuid,
                server: manateeVms[0].server_uuid,
                reason: 'ha-binder setup ' + stamp,
                log: self.log
            }, next);
        },

        function backupZookeeperData(_, next) {
            self.progress('Creating backup of zookeeper data directory ' +
                    '(this may take some time)');
            common.execRemote({
                cmd: 'cd /zookeeper/zookeeper; ' +
                    '/opt/local/bin/tar czf zookeeper-' + stamp +
                    '.tgz version-2',
                vm: vms[0].uuid,
                server: vms[0].server_uuid,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    return next(err);
                }
                if (stderr) {
                    return next(new errors.InternalError(util.format(
                                    'Backup failed: %s', stderr)));
                }
                return next();
            });
        },

        function copyZkBackupToWorkDir(_, next) {
            self.progress('Copying backup of zookeeper data to: %s', wrkDir);
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                '-T',
                '300',
                '-n',
                vms[0].server_uuid,
                '-p',
                /* JSSTYLED */
                util.format('/zones/%s/root/zookeeper/zookeeper/zookeeper-%s.tgz', vms[0].uuid, stamp),
                '--clobber',
                '-d',
                wrkDir
            ];

            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (execErr, stdout, stderr) {
                if (execErr) {
                    return next(execErr);
                }
                try {
                    // Due to the -j option of sdc-oneachnode:
                    var res = JSON.parse(stdout);
                    var out = res[0].result.stdout.trim() || null;
                    var err = res[0].result.stderr.trim() || null;
                    self.log.debug({
                        stdout: out,
                        stderr: err
                    }, 'sdc-oneachnode copy zk backup to work dir');
                    return next();
                } catch (e) {
                    self.log.error({
                        err: e,
                        stdout: stdout,
                        stderr: stderr
                    }, 'sdc-oneachnode copy zk backup to work dir');
                    return next(e);
                }
            });
        },

        function renameZkBackup(_, next) {
            var fname = path.join(wrkDir,
                    util.format('zookeeper-%s.tgz', stamp));
            self.progress('Moving backup of zookeeper data to: %s', fname);
            fs.rename(path.join(wrkDir, vms[0].server_uuid), fname, next);
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
                vms_.forEach(function (vm) {
                    if (oldVms.indexOf(vm.uuid) === -1) {
                        newVms.push(vm);
                    }
                });
                vms = vms_;
                return next();
            });
        },

        function disableZkIntoNewInsts(_, next) {
            self.progress('Disabling zookeeper into new instances');
            vasync.forEachParallel({
                inputs: newVms,
                func: function _disableZk(vm, nextVm) {
                    shared.disableRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: 'zookeeper',
                        log: self.log
                    }, nextVm);
                }
            }, next);
        },
        // rm -Rf /zookeeper/zookeeper/version-2 into the new binders
        function removeZkDataFromNewInsts(_, next) {
            self.progress('Clearing zookeeper data into new instances');
            vasync.forEachParallel({
                inputs: newVms,
                func: function _removeZkData(vm, nextVm) {
                    common.execRemote({
                        cmd: 'rm -Rf /zookeeper/zookeeper/version-2',
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: self.log
                    }, function (err, stdout, stderr) {
                        if (err) {
                            return nextVm(err);
                        }
                        if (stderr) {
                            return nextVm(new errors.InternalError(stderr));
                        }
                        return nextVm();
                    });
                }
            }, next);
        },
        // Copy data from binder0 backup into the binder instances
        function copyZkDataIntoNewInsts(_, next) {
            self.progress('Copying zookeeper data into new instances');
            var fname = path.join(wrkDir,
                    util.format('zookeeper-%s.tgz', stamp));
            vasync.forEachParallel({
                inputs: newVms,
                func: function _copyZkData(vm, nextVm) {
                    var argv = [
                        '/opt/smartdc/bin/sdc-oneachnode',
                        '-j',
                        '-T',
                        '300',
                        '-n',
                        vm.server_uuid,
                        '-g',
                        /* JSSTYLED */
                        fname,
                        '--clobber',
                        '-d',
                        util.format('/zones/%s/root/zookeeper/zookeeper',
                                vm.uuid)
                    ];

                    common.execFilePlus({
                        argv: argv,
                        log: self.log
                    }, function (execErr, stdout, stderr) {
                        if (execErr) {
                            return nextVm(execErr);
                        }
                        try {
                            // Due to the -j option of sdc-oneachnode:
                            var res = JSON.parse(stdout);
                            var out = res[0].result.stdout.trim() || null;
                            var err = res[0].result.stderr.trim() || null;
                            self.log.debug({
                                stdout: out,
                                stderr: err
                            }, 'sdc-oneachnode copy zk backup to work dir');
                            return nextVm();
                        } catch (e) {
                            self.log.error({
                                err: e,
                                stdout: stdout,
                                stderr: stderr
                            }, 'sdc-oneachnode copy zk backup to work dir');
                            return nextVm(e);
                        }
                    });
                }
            }, next);
        },
        // Untar data from binder0 into the new binder instances
        function untarZkDataIntoNewInsts(_, next) {
            self.progress('Extracting zookeeper data into new instances ' +
                    '(may take some time)');
            vasync.forEachParallel({
                inputs: newVms,
                func: function _untarZkData(vm, nextVm) {
                    common.execRemote({
                        cmd: 'cd /zookeeper/zookeeper; ' +
                            '/opt/local/bin/tar xf zookeeper-' +
                            stamp + '.tgz',
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: self.log
                    }, function (err, stdout, stderr) {
                        if (err) {
                            return nextVm(err);
                        }
                        if (stderr) {
                            return nextVm(new errors.InternalError(stderr));
                        }
                        return nextVm();
                    });
                }
            }, next);
        },
        // enable zookeeper into the new binder instances
        function enableZkIntoNewInsts(_, next) {
            self.progress('Enabling zookeeper into new instances');
            vasync.forEachParallel({
                inputs: newVms,
                func: function _enableZk(vm, nextVm) {
                    shared.enableRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: 'zookeeper',
                        log: self.sdcadm.log
                    }, nextVm);
                }
            }, next);
        },

        // Now that we're sure every binder instance has knowledge of previous
        // ensemble status, we re-configure binder instances in SAPI in order
        // to make these instances to join the same zookeeper ensemble.

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

        // Set ZK_SERVERS, not ZK_HA_SERVERS
        function cfgMoraySvc(_, next) {
            self.progress('Updating Moray service config in SAPI');
            self.sdcadm.sapi.updateService(moraySvc.uuid, {
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

        // Set ZK_SERVERS, not ZK_HA_SERVERS
        function cfgManateeSvc(_, next) {
            self.progress('Updating Manatee service config in SAPI');
            self.sdcadm.sapi.updateService(manateeSvc.uuid, {
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

        // Call config-agent sync for all the binder VMs
        function callConfigAgentSyncForAllBinders(_, next) {
            self.progress('Reloading config for all the binder VMs');
            vasync.forEachParallel({
                inputs: vms,
                func: function callCfgSync(vm, next_) {
                    common.callConfigAgentSync({
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: self.log
                    }, next_);
                }
            }, next);
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

        // Call config-agent sync for all the manatee VMs
        function callConfigAgentSyncForAllManatees(_, next) {
            self.progress('Reloading config for all the manatee VMs');
            vasync.forEachParallel({
                inputs: manateeVms,
                func: function callCfgSync(vm, next_) {
                    common.callConfigAgentSync({
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: self.log
                    }, next_);
                }
            }, next);
        },

        // HUP Manatee (Already waits for manatee shard to
        // reach the desired status):
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

        // Call config-agent sync for all the moray VMs
        function callConfigAgentSyncForAllMorays(_, next) {
            self.progress('Reloading config for all the moray VMs');
            vasync.forEachParallel({
                inputs: morayVms,
                func: function callCfgSync(vm, next_) {
                    common.callConfigAgentSync({
                        vm: vm.uuid,
                        server: vm.server_uuid,
                        log: self.log
                    }, next_);
                }
            }, next);
        },

        // HUP morays:
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
            self.progress('Waiting for moray services to be up into' +
                    ' every moray instance');
            shared.wait4Morays({
                vms: morayVms,
                sdcadm: self.sdcadm
            }, next);
        },

        function unfreezeManatee(_, next) {
            self.progress('Unfreezing manatee shard');
            common.manateeAdmRemote({
                server: manateeVms[0].server_uuid,
                vm: manateeVms[0].uuid,
                cmd: 'unfreeze',
                log: self.log
            }, function (err, stdou, stder) {
                if (err) {
                    return next(err);
                } else if (stder) {
                    return next(new errors.InternalError(stder));
                }
                return next();
            });
        },

        function clearDataBackupFromBinderVm(_, next) {
            self.progress('Removing zookeeper data backup from %s',
                    vms[0].uuid);

            common.execRemote({
                cmd: 'cd /zookeeper/zookeeper; ' +
                    'rm zookeeper-' + stamp + '.tgz',
                vm: vms[0].uuid,
                server: vms[0].server_uuid,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    return next(err);
                }
                if (stderr) {
                    return next(new errors.InternalError(stderr));
                }
                return next();
            });
        }
    ]}, function (err) {
        // Add error to history in case the update execution failed:
        if (err) {
            if (!history) {
                self.log.warn('History not set for post-setup ha-binder');
                return cb(err);
            }
            history.error = err;
        } else {
            self.progress('ha-binder setup finished.');
        }
        if (!history) {
            self.log.warn('History not set for post-setup ha-binder');
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

do_ha_binder.options = [
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

do_ha_binder.help = (
    'HA setup for binder/zookeeper services using binder instances.\n' +
    '\n' +
    'The zookeeper cluster, known as an ensemble, will use Headnode\'s\n' +
    'binder as the first member and leader of the cluster.\n' +
    '\n' +
    'Given that the existing binder instance will be included into the\n' +
    'ensemble, and we need an odd number of machines for better cluster\n' +
    'reliability, we need to specify an additional number of new instances\n' +
    'to be created, either 2 or 4, in order to complete a total of 3 or 5\n' +
    'instances.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} ha-binder -s SERVER_UUID1 -s SERVER_UUID2\n' +
    '\n' +
    '{{options}}'
);




//---- exports

module.exports = {
    do_ha_binder: do_ha_binder
};
