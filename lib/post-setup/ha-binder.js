/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * 'sdcadm post-setup ha-binder'.
 */

var p = console.log;
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var shared = require('../procedures/shared');
var svcadm = require('../svcadm');
var steps = require('../steps');



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
    }

    // Deprecation warning for `sdcadm post-setup zookeeper`:
    if (subcmd === 'zookeeper') {
        self.progress('Warning: `sdcadm post-setup zookeeper` is deprecated.' +
            '\n' + common.indent(
                'Please use `sdcadm post-setup ha-binder` instead.',
                '         '));
    }

    // Usage Error: we need at least one server:
    var aLen = args.length;
    if (!opts.servers && aLen !== 1 && aLen !== 3 && aLen !== 5) {
        cb(new errors.UsageError('invalid number of args; 1, 3 or 5 servers ' +
                    'are required'));
        return;
    }

    // Deprecation warning for `-s|--servers` option:
    if (opts.servers) {
        self.progress('Warning: `-s|--servers` option is deprecated.\n' +
            common.indent(
                'Please use `sdcadm post-setup ha-binder SERVER ...` instead.',
                '         '));
        // We only allow 2 or 4 servers given to the backwards compat mode:
        if (opts.servers.length !== 2 && opts.servers.length !== 4) {
            cb(new errors.UsageError(
                'Invalid number of binder cluster members: ' +
                opts.servers.length + '. 2 or 4 servers are required'));
        }
    }

    var app, img, instances, vms;
    var existingVmsUUIDs = [];
    var newVms = [];
    // The given server UUIDs, w/o validation:
    var targetServerUUIDs = [];
    // VMs we want to remove:
    var instancesToDelete = [];
    // Existing instances w/o modifications:
    var remainingInstances = [];
    // Servers we will create instances on:
    var servers = [];
    var changes = [];
    var arg = {}; // to pass to shared.js functions

    var willCreateInsts = true;
    var willRemoveInsts = false;

    // Used to call a lot of functions, let's save some duplication:
    var commonOpts = {
        sdcadm: self.sdcadm,
        progress: self.progress,
        log: self.log
    };

    vasync.pipeline({arg: arg, funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function getBinderSvc(ctx, next) {
            app = self.sdcadm.sdcApp;
            self.progress('Getting SDC\'s binder details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'binder',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                }
                if (svcs.length) {
                    ctx.binderSvc = svcs[0];
                }
                next();
            });
        },

        // XXX vestigial?
        shared.getUserScript, // sets `arg.userScript`.

        function getBinderInstances(ctx, next) {
            if (!ctx.binderSvc) {
                next();
                return;
            }
            self.progress('Getting SDC\'s binder instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: ctx.binderSvc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    next(instErr);
                    return;
                }
                instances = insts;
                next();
            });
        },

        function getBinderVms(_, next) {
            self.progress('Getting SDC\'s binder vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'binder',
                state: 'running',
                sort: 'create_timestamp.asc',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                vms = vms_;
                existingVmsUUIDs = vms_.map(function (vm) {
                    return vm.uuid;
                });
                next();
            });
        },

        function preloadCnapiServers(ctx, next) {
            self.sdcadm.cnapi.listServers({
                setup: true
            }, function listServersCb(listServersErr, cnapiSetupServers) {
                if (listServersErr) {
                    next(listServersErr);
                    return;
                }
                ctx.cnapiServers = cnapiSetupServers;
                next();
            });
        },

        // Backwards compatibility:
        function getServersFromArgs(ctx, next) {
            if (opts.servers) {
                var headnodeUuid;
                // We only support this backward compatible option if we have
                // a binder instance on the headnode. Let's double check it:
                const binderOnHeadnode = vms.some(function (vm) {
                    return ctx.cnapiServers.some(function findHeadnode(server) {
                        if (server.uuid === vm.server_uuid &&
                            server.headnode) {
                            headnodeUuid = server.uuid;
                            return true;
                        }
                        return false;
                    });
                });

                if (!binderOnHeadnode) {
                    next(new errors.UsageError(
                        '`-s|--servers` option is only supported when there ' +
                        'is a binder instance running into the headnode'));
                    return;
                }

                targetServerUUIDs = opts.servers.concat(headnodeUuid);
            } else {
                targetServerUUIDs = args;
            }

            // Ensure we always have the server UUID, given hostnames are
            // accepted as arguments:
            var invalidUuidsOrHostnames = [];
            targetServerUUIDs = targetServerUUIDs.map(function ensureUUIDs(s) {
                if (common.UUID_RE.test(s)) {
                    const validUuid = ctx.cnapiServers.some(function (server) {
                        return (server.uuid && server.uuid === s);
                    });
                    if (!validUuid) {
                        invalidUuidsOrHostnames.push(s);
                    }
                    return validUuid ? s : null;
                } else {
                    var sByHost = ctx.cnapiServers.filter(function byHost(sr) {
                        return (sr.hostname === s);
                    });

                    if (!sByHost.length) {
                        invalidUuidsOrHostnames.push(s);
                    }
                    return sByHost.length ? sByHost[0].uuid : null;
                }
            }).filter(function avoidNulls(x) {
                return (x !== undefined && x !== null);
            });
            if (invalidUuidsOrHostnames.length) {
                next(new errors.UsageError(
                    'Must provide valid server UUIDs or hostnames. "' +
                    invalidUuidsOrHostnames.join(', ') +
                    '" are not valid setup servers.'));
                return;
            }
            next();
        },

        function getModifications(_, next) {
            // We may want to keep an instance into a given server and remove
            // others from that server, for example, if going from:
            // `sdcadm post-setup ha-binder headnode headnode headnode` to
            // `sdcadm post-setup ha-binder headnode`; i.e, from HA back to
            // non-HA
            var finalServers = [].concat(targetServerUUIDs);
            vms.forEach(function (vm) {
                var pos = finalServers.indexOf(vm.server_uuid);
                if (pos !== -1) {
                    remainingInstances.push(vm);
                    delete finalServers[pos];
                } else {
                    instancesToDelete.push(vm);
                }
            });

            if (instancesToDelete.length) {
                willRemoveInsts = true;
            }
            var usedVms = [];
            servers = targetServerUUIDs.filter(function (s) {
                var instanceExists = remainingInstances.some(function (vm) {
                    if (usedVms.indexOf(vm.uuid) !== -1) {
                        return false;
                    }
                    if (vm.server_uuid === s) {
                        usedVms.push(vm.uuid);
                        return true;
                    }
                    return false;
                });
                return (!instanceExists);
            });
            if (servers.length) {
                willCreateInsts = true;
            } else {
                willCreateInsts = false;
            }
            next();
        },

        function checkMachinesToDelete(_, next) {
            if (instancesToDelete.length && !opts.allow_delete) {
                next(new errors.UsageError(
                    'In order to remove existing binder instances ' +
                    '"--allow-delete" option must be specified'));
                return;
            }
            next();
        },

        function checkDuplicatedServers(_, next) {
            var duplicates = targetServerUUIDs.some(function (ins, pos) {
                return (targetServerUUIDs.indexOf(ins) !== pos);
            });
            if (duplicates && !opts.dev_allow_repeat_servers) {
                next(new errors.UsageError(
                    'In order to create more than one instance into the ' +
                    'same server the option "--dev-allow-repeat-servers"' +
                    ' must be specified'
                ));
                return;
            }
            next();
        },

        function checkAtLeastOneMachineRemains(_, next) {
            if (!remainingInstances.length) {
                next(new errors.UsageError(
                    'At least one of the existing binder instances must ' +
                    'remain after all the desired changes are executed.'));
                return;
            }
            next();
        },

        function getNextInstanceId(ctx, next) {
            if (!willCreateInsts) {
                next();
                return;
            }
            self.progress('Calculating next binder instance alias');
            ctx.nextId = shared.getNextInstAliasOrdinal({
                instances: instances,
                change: {
                    service: ctx.binderSvc
                }
            }).nextId;
            next();
        },

        // This is for merely informative purposes:
        function getImage(_, next) {
            if (!willCreateInsts) {
                next();
                return;
            }
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

        function changesToBeMade(ctx, next) {
            if (!willCreateInsts && !willRemoveInsts) {
                next();
                return;
            }

            var lastId = servers.length + ctx.nextId;
            var i;

            for (i = ctx.nextId; i < lastId; i += 1) {
                var server = servers.shift();
                changes.push({
                    image: img,
                    type: 'add-instance',
                    service: ctx.binderSvc,
                    inst: {
                        type: 'vm',
                        alias: 'binder' + i,
                        version: img.version,
                        service: 'binder',
                        image: img.uuid,
                        // The binder's zk has zk_id of 1, next one needs to
                        // begin at 2, and so forth:
                        zk_id: 1 + i,
                        server: server
                    },
                    server: server
                });
            }

            instancesToDelete.forEach(function (vm) {
                changes.push({
                    instance: vm.uuid,
                    type: 'delete-instance',
                    service: ctx.binderSvc,
                    server: vm.server_uuid,
                    image: img,
                    inst: {
                        type: 'vm',
                        alias: vm.alias,
                        image: vm.image_uuid,
                        service: 'binder',
                        server: vm.server_uuid
                    }
                });
            });
            next();
        },

        function getCoreZooKeeperConfig(ctx, next) {
            if (!willCreateInsts && !willRemoveInsts) {
                next();
                return;
            }
            steps.zookeeper.getCoreZkConfig(commonOpts, function (err, zkCtx) {
                if (err) {
                    next(err);
                    return;
                }
                ctx = Object.assign(ctx, zkCtx);
                next();
            });
        },

        function confirm(_, next) {
            if (changes.length === 0) {
                next();
                return;
            }
            p('');
            p('This command will make the following changes:');
            p('');
            var out = [];

            changes.forEach(function (c) {
                var cType = c.type.split('-').join(' ');
                cType = cType[0].toUpperCase() + cType.slice(1);
                out.push(sprintf('%s "%s" in server %s',
                    cType, c.inst.alias, c.inst.server));
            });

            out.push('Update core VMs resolvers.');

            p(out.join('\n'));
            p('');
            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting ha-binder setup');
                    cb();
                    return;
                }
                p('');
                next();
            });
        },

        function freezeManatee(ctx, next) {
            if (!willCreateInsts && !willRemoveInsts) {
                next();
                return;
            }
            self.progress('Freezing manatee shard');
            common.manateeFreeze({
                vm: ctx.manateeVms[0].uuid,
                server: ctx.manateeVms[0].server_uuid,
                reason: 'ha-binder setup',
                log: self.log
            }, next);
        },

        function createZkBackup(ctx, next) {
            if (!willCreateInsts) {
                next();
                return;
            }
            steps.zookeeper.backupZKData(Object.assign({
                ctx: ctx
            }, commonOpts), function backupCb(err, stamp) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.stamp = stamp;
                next();
            });
        },

        function createBinderInstances(_, next) {
            if (!willCreateInsts) {
                next();
                return;
            }

            vasync.forEachPipeline({
                inputs: changes.filter(function (c) {
                    return (c.type === 'add-instance');
                }),
                func: function createBinderInstance(change, nextInst) {
                    shared.createInstance({
                        opts: commonOpts,
                        server: change.inst.server,
                        img: change.image,
                        alias: change.inst.alias,
                        change: change,
                        metadata: {
                            ZK_ID: String(change.inst.zk_id)
                        }
                    }, nextInst);
                }
            }, next);
        },

        function removeBinderInstances(_, next) {
            if (!willRemoveInsts) {
                next();
                return;
            }
            vasync.forEachPipeline({
                inputs: instancesToDelete,
                func: function deleteBinderInstance(inst, nextInst) {
                    self.progress(sprintf(
                        'Removing "%s" (%s) instance in server %s',
                        inst.uuid, inst.alias, inst.server_uuid));
                    self.sdcadm.sapi.deleteInstance(
                        inst.uuid, function sapiCb(sapiErr) {
                            if (sapiErr) {
                                nextInst(new errors.SDCClientError(sapiErr,
                                    'sapi'));
                                return;
                            }
                            nextInst();
                        });
                }
            }, next);
        },

        function hupHermes(_, next) {
            if (!willCreateInsts && !willRemoveInsts) {
                next();
                return;
            }
            svcadm.restartHermes(commonOpts, next);
        },

        function getBinderInstancesAfterCreation(ctx, next) {
            self.sdcadm.sapi.listInstances({
                service_uuid: ctx.binderSvc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    next(instErr);
                    return;
                }
                ctx.binderInsts = instances = insts;
                next();
            });
        },

        function getBinderVmsAfterCreation(ctx, next) {
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'binder',
                state: 'running',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                vms_.forEach(function (vm) {
                    if (existingVmsUUIDs.indexOf(vm.uuid) === -1) {
                        newVms.push(vm);
                    }
                });
                ctx.binderVms = vms = vms_;
                ctx.binderIps = vms.map(function (vm) {
                    return (vm.nics[0].ip);
                });
                next();
            });
        },

        function replaceZkDataIntoNewInsts(ctx, next) {
            if (!willCreateInsts) {
                next();
                return;
            }
            vasync.forEachParallel({
                inputs: newVms,
                func: function replaceZkData(vm, nextVm) {
                    steps.zookeeper.replaceZKData(Object.assign({
                        vm: vm,
                        stamp: ctx.stamp
                    }, commonOpts), nextVm);
                }
            }, next);
        },


        function reconfigureZkCoreCfg(ctx, next) {
            if (!willCreateInsts && !willRemoveInsts) {
                next();
                return;
            }

            steps.zookeeker.updateCoreZkConfig(Object.assign({
                ctx: ctx
            }, commonOpts), next);
        },

        function clearDataBackupFromBinderVm(ctx, next) {
            if (!willCreateInsts) {
                next();
                return;
            }
            steps.zookeeper.clearZKBackup({
                progress: self.progress,
                vm: vms[0],
                stamp: ctx.stamp,
                log: self.log
            }, next);
        },

        function ensureAdminNetworkHasCorrectResolvers(ctx, next) {
            self.sdcadm.napi.listNetworks({
                name: 'admin',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (err, nets) {
                if (err) {
                    next(new errors.SDCClientError(err, 'napi'));
                    return;
                }

                if (!nets.length) {
                    next(new errors.InternalError(
                        'Cannot find Admin network in NAPI'));
                    return;
                }

                ctx.admin_network_uuid = nets[0].uuid;
                var changed = (
                    ctx.binderIps.length !== nets[0].resolvers.length ||
                    !ctx.binderIps.every(function checkIp(ip, pos) {
                        return (ip === nets[0].resolvers[pos]);
                    }));

                if (!changed) {
                    next();
                    return;
                }

                self.progress(
                    'Updating admin network resolvers from [%s] to [%s]',
                    nets[0].resolvers.join(', '),
                    ctx.binderIps.join(', ')
                );
                self.sdcadm.napi.updateNetwork(ctx.admin_network_uuid, {
                    resolvers: ctx.binderIps
                }, function (err2) {
                    if (err2) {
                        next(new errors.SDCClientError(err2, 'napi'));
                        return;
                    }
                    next();
                });
            });
        },

        function updateCoreVmsResolvers(ctx, next) {
            self.progress('Updating core SDC VMs resolvers');
            steps.binder.checkCoreVmInstancesResolvers(Object.assign({
                ctx: ctx
            }, commonOpts), function checkResolversCb(err, resolvers) {
                if (err) {
                    next(err);
                    return;
                }

                Object.keys(resolvers).forEach(function (r) {
                    self.progress(
                        'VM %s resolvers need to be updated from [%s] to [%s]',
                        r, resolvers[r].current.join(', '),
                        resolvers[r].expected.join(', '));
                });

                steps.binder.updateCoreVmsResolvers(Object.assign({
                    fixableResolvers: resolvers
                }, commonOpts), next);
            });
        }


    ]}, function (err) {
        var msg = 'ha-binder setup finished';
        if (err) {
            msg += ' with errors';
        }
        self.progress(msg);
        cb(err);
    });
}

do_ha_binder.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['allow-delete'],
        type: 'bool',
        help: 'Allow replacement/deletion of existing binder instances.'
    },
    {
        names: ['dev-allow-repeat-servers'],
        type: 'bool',
        help: 'For development, allow a binder cluster with multiple\n' +
              'instances on the same server.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfString',
        hidden: true,
        help: 'UUID for the target servers. At least 2 are required.'
    },
    {
        names: ['members', 'm'],
        type: 'integer',
        hidden: true,
        help: 'Number of instances to create (2 or 4). Default: 2'
    }

];

do_ha_binder.help = (
    'Setup the binder service for high availability (HA).\n' +
    '\n' +
    'The binder service provides internal DNS to Triton core services.\n' +
    'It also holds a zookeeper (ZK) cluster used by some Triton core\n' +
    'services. To best support ZK availability we want an odd number of\n' +
    'binder instances. One, three, or five instances are supported.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} ha-binder SERVER1 SERVER2 ...\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    '"SERVER ..." should list one, three, or five setup servers (hostname\n' +
    'or UUID) on which a binder instance is desired. Note that this\n' +
    '*includes* existing binder instances, e.g. the "binder0" instance\n' +
    'typically on the initial headnode.\n' +
    '\n' +
    'For backward compatibility, \n' +
    '`sdcadm post-setup ha-binder -s SERVER2 -s SERVER3` is accepted\n' +
    '(a) when there is only a single binder on the headnode and \n' +
    '(b) to mean that two binder instances should be added for a total of\n' +
    'three instances. The new calling form is preferred because it is\n' +
    'idempotent.\n' +
    '\n' +
    'Examples:\n' +
    '    # Ensure a 3-instance binder cluster on the given 3 servers.\n' +
    '    sdcadm post-setup ha-binder headnode SERVER2 SERVER3\n' +
    '\n' +
    '    # Deprecated. Same result as preview example.\n' +
    '    sdcadm post-setup ha-binder -s SERVER2 -s SERVER3\n' +
    '\n' +
    'At least one of the existing binder instances must remain unchanged\n' +
    'during the process. In case the desired configuration does not \n' +
    'include any of the existing instances, the recommended procedure is\n' +
    'to complete the removal or replacement of all the desired instances\n' +
    'in two steps, achieving the replacement of the instance that must\n' +
    'remain unchanged during the first execution of the command during\n' +
    'the second execution. For example, say we want to "move" our binder\n' +
    'instances from servers "headnode", "SERVER1" and "SERVER2" to the\n' +
    'new servers "SERVER4", "SERVER5" and "new-headnode". We can proceed\n' +
    'as follows:\n' +
    '\n' +
    '    # Replace all the instances but the first one:\n' +
    '    sdcadm post-setup ha-binder headnode SERVER4 SERVER5 \n' +
    '    # Replace the first one while keeping the new ones:\n' +
    '    sdcadm post-setup ha-binder new-headnode SERVER4 SERVER5 \n' +
    '\n'
);




// --- exports

module.exports = {
    do_ha_binder: do_ha_binder
};
