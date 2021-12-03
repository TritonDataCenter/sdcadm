/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/* eslint-disable callback-return */

var util = require('util');
var format = util.format;
var fs = require('fs');

var jsprim = require('jsprim');
var schemas = require('joyent-schemas');
var vasync = require('vasync');
var read = require('read');
var assert = require('assert-plus');

var common = require('../common');
var errors = require('../errors');
var steps = require('../steps');


/*
 * These services are broken and have been removed from new installs and the
 * agentsshar. We want to skip them here so we're not broken by them being
 * missing.
 */
var SERVICE_BLACKLIST = ['cabase', 'cainstsvc'];

/*
 * These services haven't always existed and don't have scripts in
 * sdc-headnode that create SDC app metadata in SAPI for them. We
 * will check them during update-other and add their metadata if
 * we need to.
 */
var NEW_SERVICES = ['papi', 'mahi', 'cns', 'portolan', 'docker'];

/*
 * The 'sdcadm experimental update-other' CLI subcommand.
 */

/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-other.sh".
 */

function do_update_other(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var log = self.log;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    // Helper functions

    function updateService(uuid, svcOpts, next) {
        self.sdcadm.sapi.updateService(uuid, svcOpts, function (err, _svc) {
            if (err) {
                next(new errors.SDCClientError(err, 'sapi'));
                return;
            }
            next();
        });
    }

    function updateSdcApp(svcOpts, next) {
        var uuid = self.sdcadm.sdcApp.uuid;
        self.sdcadm.sapi.updateApplication(uuid, svcOpts, function (err) {
            if (err) {
                next(new errors.SDCClientError(err, 'sapi'));
                return;
            }
            next();
        });
    }

    function readField(field, default_, cbRead) {
        if (cbRead === undefined) {
            cbRead = default_;
            default_ = undefined;
        }
        assert.object(field, 'field');
        assert.func(cbRead);

        var readOpts = {
            prompt: field.name + ':',
            silent: field.hidden,
            default: default_
        };

        read(readOpts, function (rErr, val) {
            if (rErr) {
                cbRead(rErr);
                return;
            }

            val = val.trim();
            if (!field.confirm) {
                cbRead(null, val);
                return;
            }

            readOpts.prompt = field.name + ' confirm:';
            read(readOpts, function (rErr2, val2) {
                if (rErr2) {
                    cbRead(rErr2);
                    return;
                }

                val2 = val2.trim();
                if (val !== val2) {
                    cbRead(new Error(format(
                        '%s values do not match', field.name)));
                } else {
                    cbRead(null, val);
                }
            });
        });
    }
    var context = {
        sdcadm: self.sdcadm,
        log: self.log,
        progress: self.progress
    };
    vasync.pipeline({arg: context, funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        /*
         * Time to finally make the switch to the new agents by default.
         */
        function handleNoRabbit(ctx, next) {
            if (opts.skip_no_rabbit) {
                next();
                return;
            }

            steps.noRabbit.noRabbitEnable(ctx, next);
        },

        function getServices(ctx, next) {
            self.sdcadm.getServices({}, function (err, svcs) {
                if (err) {
                    next(err);
                    return;
                }

                // Filter out any blacklisted services
                ctx.svcs = svcs.filter(function ignoreBlacklistedServices(svc) {
                    return (SERVICE_BLACKLIST.indexOf(svc.name) === -1);
                });

                ctx.svcFromName = {};
                svcs.forEach(function (svc) {
                    ctx.svcFromName[svc.name] = svc;
                });

                next();
            });
        },

        // Remove deprecated params.resolvers:
        function removeSdcAppResolvers(_, next) {
            if (!self.sdcadm.sdcApp.params.resolvers) {
                next();
                return;
            }
            progress('Remove deprecated "sdc" SAPI app params resolvers');
            self.sdcadm.sapi.updateApplication(self.sdcadm.sdcApp.uuid, {
                action: 'delete',
                params: {
                    resolvers: []
                }
            }, function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else {
                    next();
                }
            });
        },

        function updateSdcAppSchemas(_, next) {
            var currSchema = self.sdcadm.sdcApp.metadata_schema;
            var latestSchema = schemas.sdc.sdc_app;
            if (currSchema && jsprim.deepEqual(currSchema, latestSchema)) {
                next();
                return;
            }

            self.log.debug({before: currSchema, after: latestSchema},
                'update sdc app metadata_schema');
            progress('Update "sdc" SAPI app metadata_schema');
            self.sdcadm.sapi.updateApplication(self.sdcadm.sdcApp.uuid, {
                action: 'update',
                metadata_schema: latestSchema
            }, function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else {
                    next();
                }
            });
        },

        function updateMaintainResolvers(ctx, next) {
            vasync.forEachParallel({
                inputs: ctx.svcs,
                func: function updateSvc(svc, nextSvc) {
                    if (svc.type === 'vm' && svc.params &&
                        svc.params.maintain_resolvers !== true) {
                        progress(
                            'Update "%s" service "maintain_resolvers" param',
                            svc.name);
                        updateService(svc.uuid,
                            { params: { maintain_resolvers: true } },
                            nextSvc);
                        return;
                    }
                    nextSvc();
                }
            }, next);
        },

        function updateSshPubKeyManifest(_, next) {
            var keyManifest = self.sdcadm.sdcApp.manifests.sdc_public_key;

            self.sdcadm.sapi.getManifest(keyManifest,
                function _updateMfest(getErr, mfest) {
                    if (getErr) {
                        self.log.error({error: getErr},
                            'Error fetching sapi manifest');
                    }
                    if (!mfest.hasOwnProperty('post_cmd_linux')) {
                        mfest.post_cmd_linux = mfest.post_cmd;
                        self.sdcadm.sapi.createManifest(mfest,
                            function _cmcb(crErr, newMn) {
                                if (crErr) {
                                    self.log.error({error: crErr},
                                        'Error updating sapi manifest');
                                }
                                self.log.debug({manifest: newMn},
                                    'New manifest created');
                                next();
                            }
                        );
                    } else {
                        next();
                    }
                    return;
                }
            );
        },

        function updateServiceDomains(ctx, next) {
            var svcsToUpdate = [];
            NEW_SERVICES.forEach(function (svcName) {
                var svc = ctx.svcFromName[svcName];
                if (svc && svc.metadata && (!svc.metadata.SERVICE_DOMAIN ||
                    !svc.metadata['sapi-url'])) {
                    svcsToUpdate.push(svc);
                }
            });

            vasync.forEachParallel({
                inputs: svcsToUpdate,
                func: function updateSvc(svc, nextSvc) {
                    var mdata = self.sdcadm.sdcApp.metadata;
                    var svcDomain = format('%s.%s.%s', svc.name,
                        mdata.datacenter_name, mdata.dns_domain);
                    progress('Set "%s" service "metadata.SERVICE_DOMAIN"',
                        svc.name);
                    updateService(svc.uuid,
                        {
                            metadata: {
                                SERVICE_DOMAIN: svcDomain,
                                'sapi-url': mdata['sapi-url']
                            }
                        },
                        nextSvc);
                }
            }, next);
        },

        function updateAppDomains(ctx, next) {
            var mdata = self.sdcadm.sdcApp.metadata;
            var mdataUpdates = {};

            NEW_SERVICES.forEach(function (svcName) {
                var svc = ctx.svcFromName[svcName];
                if (!svc) {
                    return;
                }
                var svcDomain = format('%s.%s.%s', svc.name,
                    mdata.datacenter_name, mdata.dns_domain);
                var FOO_SERVICE = svc.name.toUpperCase() + '_SERVICE';
                if (!mdata[FOO_SERVICE]) {
                    mdataUpdates[FOO_SERVICE] = svcDomain;
                }
                var foo_domain = svc.name + '_domain';
                if (!mdata[foo_domain]) {
                    mdataUpdates[foo_domain] = svcDomain;
                }
            });

            if (Object.keys(mdataUpdates).length === 0) {
                next();
                return;
            }
            progress('Adding domain keys to "sdc" SAPI app metadata: %j',
                mdataUpdates);
            updateSdcApp({metadata: mdataUpdates}, next);
        },

        function getSdc4096Pkg(ctx, next) {
            self.sdcadm.papi.list({
                owner_uuid: self.sdcadm.config.ufds_admin_uuid,
                name: 'sdc_4096',
                active: true
            }, {}, function (err, pkgs) {
                if (err) {
                    next(err);
                    return;
                }
                if (pkgs.length) {
                    assert.equal(pkgs.length, 1);
                    ctx.sdc_4096 = pkgs[0];
                }
                next();
            });
        },

        function ensureSdc4096Pkg(ctx, next) {
            if (ctx.sdc_4096) {
                next();
                return;
            }

            /*
             * Earlier SDCs didn't have the 'sdc_4096' package. Add it.
             */
            progress('Creating "sdc_4096" package');
            self.sdcadm.papi.add({
                name: 'sdc_4096',
                active: true,
                cpu_cap: 400,
                max_lwps: 1000,
                max_physical_memory: 4096,
                max_swap: 8192,
                quota: 25600,
                vcpus: 1,
                version: '1.0.0',
                zfs_io_priority: 20,
                owner_uuids: [
                    self.sdcadm.config.ufds_admin_uuid
                ],
                default: false
            }, function (err, pkg) {
                if (err) {
                    next(err);
                } else {
                    ctx.sdc_4096 = pkg;
                    next();
                }
            });
        },

        /*
         * Clean out package field cruft from some of the services that we
         * created in sapi post-setup (e.g. nat and docker).
         */
        function cleanPkgCruftFromSomeSvcs(ctx, next) {
            var svcNames = ['docker', 'nat'];

            var paramUpdatesFromSvcName = {};
            svcNames.forEach(function (svcName) {
                var svc = ctx.svcFromName[svcName];
                if (!svc) {
                    return;
                }

                var paramUpdates = {};
                if (svc.params.customer_metadata &&
                    Object.keys(svc.params.customer_metadata).length === 0) {
                    paramUpdates.customer_metadata = null;
                }
                ['cpu_shares',
                 'cpu_cap',
                 'zfs_io_priority',
                 'max_lwps',
                 'max_physical_memory',
                 'max_locked_memory',
                 'max_swap',
                 'quota',
                 'package_version',
                 'package_name'].forEach(function (field) {
                    if (svc.params.hasOwnProperty(field)) {
                        paramUpdates[field] = null;
                    }
                });

                // 'nat' zone service shouldn't have a "networks" (TOOLS-1101)
                if (svcName === 'nat') {
                    if (svc.params.hasOwnProperty('networks')) {
                        paramUpdates.networks = null;
                    }
                }

                if (Object.keys(paramUpdates).length !== 0) {
                    paramUpdatesFromSvcName[svcName] = paramUpdates;
                }
            });

            vasync.forEachPipeline({
                inputs: Object.keys(paramUpdatesFromSvcName),
                func: function updateSvc(svcName, nextSvc) {
                    var paramUpdates = paramUpdatesFromSvcName[svcName];
                    log.debug({paramUpdates: paramUpdates},
                        'docker service param cruft');
                    progress('Remove package cruft from "%s" svc params: %s',
                        svcName, Object.keys(paramUpdates).join(', '));

                    var svcUuid = ctx.svcFromName[svcName].uuid;
                    self.sdcadm.sapi.updateService(svcUuid, {
                        action: 'delete',
                        params: paramUpdates
                    }, errors.sdcClientErrWrap(nextSvc, 'sapi'));
                }
            }, next);
        },

        function ensureCloudapiSvcIsCore(ctx, next) {
            var cloudapiSvc = ctx.svcFromName.cloudapi;
            self.sapi.updateService(cloudapiSvc.uuid, {
                tags: {
                    smartdc_type: 'core'
                }
            }, next);
        },

        function ensureDockerPkg_Svc(ctx, next) {
            var dockerSvc = ctx.svcFromName.docker;
            if (!dockerSvc ||
                dockerSvc.params.billing_id === ctx.sdc_4096.uuid) {
                next();
                return;
            }

            progress('Update "docker" service params to use sdc_4096 pkg');
            self.sdcadm.sapi.updateService(dockerSvc.uuid, {
                params: {
                    billing_id: ctx.sdc_4096.uuid
                }
            }, next);
        },

        function ensureDockerPkg_Insts(ctx, next) {
            var dockerSvc = ctx.svcFromName.docker;
            if (!dockerSvc) {
                next();
                return;
            }

            // Dev Note: sdcadm.listInsts returns the subset of objects. It
            // would be nice if it returned full VM objects so we don't have to
            // resort to VMAPI calls here.
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'docker',
                state: 'running',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, dockerVms) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }

                var toResize = dockerVms.filter(function (vm) {
                    return vm.billing_id !== ctx.sdc_4096.uuid;
                });
                if (!toResize.length) {
                    next();
                    return;
                }

                progress('Resizing %d docker instance(s) to sdc_4096 ' +
                    'package: %s', toResize.length,
                    toResize.map(
                        function (vm) {
                            return vm.alias;
                        }).join(', '));
                vasync.forEachPipeline({
                    inputs: toResize,
                    func: function resizeDockerVm(vm, nextVm) {
                        // TODO: add vmapi.updateVmAndWait and use that
                        self.sdcadm.vmapi.updateVm({
                            uuid: vm.uuid,
                            payload: {
                                force: opts.force_resize,
                                billing_id: ctx.sdc_4096.uuid
                            }
                        }, function (resizeErr, jobInfo) {
                            if (resizeErr) {
                                // We want to point out the '--force-resize'
                                // option when appropriate.
                                if (errors.haveErrCode(resizeErr,
                                    'InsufficientCapacity')) {
                                    progress('Note: You can use ' +
                                        '"--force-resize" to override ' +
                                        '"InsufficientCapacity".');
                                }
                                nextVm(new errors.SDCClientError(
                                    resizeErr, 'vmapi'));
                                return;
                            }
                            progress('Resizing vm %s (%s). Note: *not* ' +
                                'waiting for job %s', vm.uuid, vm.alias,
                                jobInfo.job_uuid);
                            nextVm();
                        });
                    }
                }, next);
            });
        },

        function updateRegionName(_, next) {
            var regionName;
            var keyInitiallyMounted;

            fs.readFile('/usbkey/config', {
                encoding: 'utf8'
            }, function (err, data) {
                if (err) {
                    next(err);
                    return;
                } else if (data.search(/region_name=/) !== -1) {
                    log.debug('region_name is up to date');
                    next();
                    return;
                }

                function readRegionName(__, next_) {
                    progress('Updating "region_name" for this data center');

                    var field = {
                        name: 'region_name',
                        hidden: false,
                        confirm: true
                    };
                    readField(field, function (err1, value) {
                        if (err1) {
                            next_(err1);
                            return;
                        }

                        regionName = value;
                        next_();
                        return;
                    });
                }

                function appendRegionName(__, next_) {
                    var region = 'region_name=' + regionName + '\n';
                    fs.appendFile('/mnt/usbkey/config', region,
                            function (err1) {
                        if (err1) {
                            next_(err1);
                            return;
                        }

                        var argv = [
                            '/usr/bin/cp',
                            '/mnt/usbkey/config',
                            '/usbkey/config'
                        ];
                        common.execFilePlus({argv: argv, log: self.log}, next_);
                    });
                }

                function updateSapiRegionName(__, next_) {
                    var metadata = { region_name: regionName };
                    updateSdcApp({ metadata: metadata }, next_);
                }

                function isKeyMounted(__, next_) {
                    common.isUsbKeyMounted(self.log, function (er, mounted) {
                        if (er) {
                            next_(er);
                            return;
                        }
                        keyInitiallyMounted = mounted;
                        next_();
                    });
                }

                vasync.pipeline({funcs: [
                    readRegionName,
                    isKeyMounted,
                    function mountUsbKey(__, next2) {
                        if (keyInitiallyMounted) {
                            next2();
                            return;
                        }
                        common.mountUsbKey(self.log, next2);
                    },
                    appendRegionName,
                    function unmountUsbKey(__, next2) {
                        if (keyInitiallyMounted) {
                            next2();
                            return;
                        }
                        common.unmountUsbKey(self.log, next2);
                    },
                    updateSapiRegionName
                ]}, next);
            });
        },

        function addSapiDomainToNodeConfig(_, next) {
            var nodeConfig = '/usbkey/extra/joysetup/node.config';
            fs.readFile(nodeConfig, { encoding: 'utf8' }, function (err, data) {
                if (err) {
                    next(err);
                    return;
                } else if (data.search(/sapi_domain=/) !== -1) {
                    log.debug('sapi_domain already present on node.config');
                    next();
                    return;
                }

                progress('Appending "sapi_domain" to node.config');
                var mdata = self.sdcadm.sdcApp.metadata;
                var sapiDomain = format('sapi_domain=\'sapi.%s.%s\'\n',
                    mdata.datacenter_name, mdata.dns_domain);
                fs.appendFile(nodeConfig, sapiDomain, next);
            });
        },

        /*
         * The default configuration includes a set of updated size parameters
         * for the "params" object of each SAPI service, and for the VMs that
         * represent instances of that service.  Walk each service that
         * specifies parameters, and apply any updates needed to bring us
         * up-to-date.
         */
        function updateSizeParameters(ctx, next) {
            var updatedParams = self.sdcadm.config.updatedSizeParameters;
            assert.object(updatedParams);

            vasync.forEachPipeline({
                inputs: Object.keys(updatedParams),
                func: function updateSizeParametersOne(svcName, done) {
                    assert.object(ctx.svcFromName[svcName]);

                    steps.updateVmSize.updateSizeParameters({
                        progress: progress,
                        service: ctx.svcFromName[svcName],
                        log: self.log,
                        sdcadm: self.sdcadm,
                        params: updatedParams[svcName]
                    }, done);
                }
            }, next);
        },

        function runVmapiMigrations(_, next) {
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'vmapi',
                state: 'running',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                var vmapi = vms_[0];
                self.sdcadm.imgapi.getImage(vmapi.image_uuid,
                        function (imgErr, img) {
                    if (imgErr) {
                        next(imgErr);
                        return;
                    }
                    var parts = img.version.split('-');
                    var curImg = parts[parts.length - 2];
                    if (curImg >= '20141030T234934Z') {
                        progress('Running VMAPI migrations');
                        var cmd = 'cd /opt/smartdc/vmapi && ' +
                            './build/node/bin/node ' +
                            'tools/migrations/add-docker-index.js';

                        common.execRemote({
                            server: vmapi.server_uuid,
                            vm: vmapi.uuid,
                            cmd: cmd,
                            log: log
                        }, next);
                    } else {
                        next();
                    }
                });
            });
        },

        function removeHostvolumeInstances(ctx, next) {
            if (!ctx.svcFromName.hostvolume) {
                next();
                return;
            }

            self.sdcadm.sapi.listInstances({
                service_uuid: ctx.svcFromName.hostvolume.uuid
            }, function (err, insts) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }

                if (!insts.length) {
                    next();
                    return;
                }

                progress('Removing deprecated hostvolume instances');
                vasync.forEachPipeline({
                    inputs: insts,
                    func: function deleteHostvolumeInst(inst, nextInst) {
                        self.sdcadm.sapi.deleteInstance(inst.uuid,
                                function (iErr) {
                            nextInst(iErr);
                        });
                    }
                }, function (instErr) {
                    return next(instErr);
                });
            });
        },

        function removeHostvolumeService(ctx, next) {
            if (!ctx.svcFromName.hostvolume) {
                next();
                return;
            }
            progress('Removing deprecated hostvolume service');
            self.sdcadm.sapi.deleteService(ctx.svcFromName.hostvolume.uuid,
                    function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                next();
            });
        },

        function updateAgentsImages(ctx, next) {
            var svcsToUpdate = [];
            ctx.svcs.forEach(function (svc) {
                if (svc.type === 'agent' && svc.params &&
                        !svc.params.image_uuid &&
                        svc.name !== 'dockerlogger') {
                    svcsToUpdate.push(svc);
                }
            });

            function updateAgentImage(agent, callback) {
                vasync.pipeline({
                    funcs: [
                        function readAgentImg(_, _cb) {
                            var name = agent.name;
                            var imgUUIDPath = util.format(
                                '/opt/smartdc/agents/lib/' +
                                'node_modules/%s/image_uuid',
                                name);
                            fs.readFile(imgUUIDPath, {
                                encoding: 'utf8'
                            }, function (err, data) {
                                if (err) {
                                    self.sdcadm.log.error({err: err},
                                        'Error reading agent image uuid');
                                    _cb(err);
                                    return;
                                }
                                agent.params.image_uuid = data.trim();
                                _cb();
                            });
                        },
                        function updateAgentImg(_, _cb) {
                            progress('Updating service for agent \'%s\'',
                                    agent.name);
                            updateService(agent.uuid, {
                                params: agent.params
                            }, _cb);
                        }
                    ]
                }, callback);
            }

            vasync.forEachParallel({
                inputs: svcsToUpdate,
                func: updateAgentImage
            }, next);
        },

        /*
         * Clean up after older vers of 'sdcadm post-setup common-external-nics'
         * that did not set the "external" NIC to be the primary.
         */
        function updateCommonExternalNics(ctx, next) {
            var initialNetworks = ['admin'];
            var oldNetworks = ['admin', 'external'];
            var newNetworks = [
                { name: 'admin' },
                { name: 'external', primary: true}
            ];
            var toUpdateItems = [];

            var svcNames = ['adminui', 'imgapi'];

            var svcs = ctx.svcs.filter(function (svc) {
                return (svcNames.indexOf(svc.name) !== -1);
            });

            self.sdcadm.checkMissingNics({
                svcNames: svcNames,
                nicTag: 'external'
            }, function (sdcadmErr, nicLists) {
                if (sdcadmErr) {
                    next(sdcadmErr);
                    return;
                }

                /*
                 * We get the set of uuids of services that have instances that
                 * lack an external nic.
                 */
                var svcsWithoutNic = new Set();
                nicLists.instsWithoutNic.forEach(function addToSet(inst) {
                    svcsWithoutNic.add(inst.service_uuid);
                });

                /*
                 * If the service is in the set of services that have instances
                 * that lack an external nic, then the action of adding the nics
                 * to imgapi0 or adminui0 is still pending, and, on that case,
                 * we can safely skip the service here. Otherwise, we need to
                 * check if params match the old/initial networks and update
                 * params if so.
                 */
                svcs.forEach(function (svc) {
                    if (!svcsWithoutNic.has(svc.uuid) &&
                        svc.params &&
                        (jsprim.deepEqual(svc.params.networks, oldNetworks) ||
                        jsprim.deepEqual(svc.params.networks, initialNetworks))
                    ) {
                        toUpdateItems.push({
                            svcName: svc.name,
                            svcUuid: svc.uuid,
                            paramsNetworks: newNetworks
                        });
                    }
                });

                if (toUpdateItems.length === 0) {
                    next();
                    return;
                }

                vasync.forEachPipeline({
                    inputs: toUpdateItems,
                    func: function handleOneUpdateItem(item, nextItem) {
                        progress('Update "%s" service params.networks to ' +
                            'ensure the external NIC is primary',
                            item.svcName);
                        updateService(item.svcUuid, {
                            params: {
                                networks: item.paramsNetworks
                            }
                        }, function (updateErr) {
                            if (updateErr) {
                                nextItem(new errors.SDCClientError(
                                    updateErr, 'sapi'));
                            } else {
                                nextItem();
                            }
                        });
                    }
                }, next);
            });
        },

        steps.sapi.ensureAgentServices,

        /*
         * Previously CloudAPI configuration did not include an external
         * network. We need to add it and make sure it's primary.
         */
        function updateCloudapiCfg(ctx, next) {
            var cloudapiSvc = ctx.svcs.filter(function (svc) {
                return svc.name === 'cloudapi';
            })[0];

            // The "cloudapi" SAPI service is created by default by headnode
            // setup. However an operator *can* delete that SAPI service if
            // they have no use for cloudapi.
            if (!cloudapiSvc || cloudapiSvc.params.networks.length > 1) {
                next();
                return;
            }
            progress('Add "external" network parameter to "CloudAPI" service');
            updateService(cloudapiSvc.uuid, { params: {
                networks: [
                    { name: 'admin' },
                    { name: 'external', primary: true}
                ]
            } }, function (cloudapiErr) {
                if (cloudapiErr) {
                    next(new errors.SDCClientError(cloudapiErr, 'sapi'));
                    return;
                }
                next();
            });
        },

        // Need to mount /usbkey/extra to provide access to node.config through
        // Booter.
        function updateBooterCfg(ctx, next) {
            var booterSvc = ctx.svcs.filter(function (svc) {
                return svc.name === 'dhcpd';
            })[0];

            if (!booterSvc || booterSvc.params.filesystems.length > 1) {
                next();
                return;
            }

            progress('Mount "/usbkey/extra" for "Dhcpd" service');
            updateService(booterSvc.uuid, { params: {
                filesystems: booterSvc.params.filesystems.concat({
                    source: '/usbkey/extra',
                    target: '/tftpboot/extra',
                    type: 'lofs',
                    options: [
                        'ro',
                        'nodevices'
                    ]
                })
            } }, function (booterErr) {
                if (booterErr) {
                    next(new errors.SDCClientError(booterErr, 'sapi'));
                    return;
                }

                self.sdcadm.sapi.listInstances({
                    service_uuid: booterSvc.uuid
                }, function (err, insts) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }

                    if (!insts.length) {
                        next();
                        return;
                    }

                    vasync.forEachPipeline({
                        inputs: insts,
                        func: function mountExtra(inst, nextInst) {
                            progress(
                                'Mounting "/usbkey/extra" for instance: %s',
                                inst.uuid);
                            vasync.pipeline({funcs: [
                                function ceateMountPath(_, nextStep) {
                                    var argv = [
                                        'mkdir', '-p',
                                        '/zones/' + inst.uuid +
                                        '/root/tftpboot/extra'
                                    ];
                                    common.execFilePlus({
                                        argv: argv,
                                        log: self.sdcadm.log
                                    }, nextStep);
                                },
                                function updateZoneCfg(_, nextStep) {
                                    var zonecfg = 'add fs; set type=lofs; ' +
                                        'set dir=/tftpboot/extra; ' +
                                        'set special=/usbkey/extra; ' +
                                        'set options=ro; end';
                                    var argv = [
                                        '/usr/sbin/zonecfg', '-z',
                                        inst.uuid,
                                        zonecfg
                                    ];
                                    common.execFilePlus({
                                        argv: argv,
                                        log: self.sdcadm.log
                                    }, nextStep);
                                },
                                // This one is to avoid zone reboot
                                function createLofsMount(_, nextStep) {
                                    var argv = [
                                        'mount', '-F', 'lofs',
                                        '-o nodevices,ro',
                                        '/usbkey/extra',
                                        '/zones/' + inst.uuid +
                                        '/root/tftpboot/extra'
                                    ];
                                    common.execFilePlus({
                                        argv: argv,
                                        log: self.sdcadm.log
                                    }, nextStep);
                                }
                            ]}, nextInst);
                        }
                    }, next);
                });
            });
        },
        steps.sapi.ensureAssetsService
    ]}, cb);
}

do_update_other.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['skip-no-rabbit'],
        type: 'bool',
        help: 'Do not turn on the no_rabbit configuration setting.'
    },
    {
        names: ['force-resize'],
        type: 'bool',
        help: 'Part of this command involves resizing some SDC core zones. ' +
            'If this means running out of capacity on the CN, then that ' +
            'will fail. On the overprovisioned CoaL development environment ' +
            'it is useful to be able to force this.'
    }
];
do_update_other.help = (
    'Temporary grabbag for small SDC update steps.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-other\n' +
    '\n' +
    '{{options}}'
);

do_update_other.logToFile = true;

// --- exports

module.exports = {
    do_update_other: do_update_other
};
