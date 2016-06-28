/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

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
        return cb(new errors.UsageError('too many args: ' + args));
    }

    // Used by history
    var history;
    var changes = [];

    // Helper functions

    function updateService(uuid, svcOpts, next) {
        self.sdcadm.sapi.updateService(uuid, svcOpts, function (err, svc) {
            if (err) {
                return next(new errors.SDCClientError(err, 'sapi'));
            }
            next();
        });
    }

    function updateSdcApp(svcOpts, next) {
        var uuid = self.sdcadm.sdc.uuid;
        self.sdcadm.sapi.updateApplication(uuid, svcOpts, function (err, svc) {
            if (err) {
                return next(new errors.SDCClientError(err, 'sapi'));
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
                return cbRead(rErr);
            }

            val = val.trim();
            if (!field.confirm) {
                return cbRead(null, val);
            }

            readOpts.prompt = field.name + ' confirm:';
            read(readOpts, function (rErr2, val2) {
                if (rErr2) {
                    return cbRead(rErr2);
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
        /*
         * Time to finally make the switch to the new agents by default.
         */
        function handleNoRabbit(ctx, next) {
            if (opts.skip_no_rabbit) {
                return next();
            }

            steps.noRabbitEnable(ctx, next);
        },

        function getServices(ctx, next) {
            self.sdcadm.getServices({}, function (err, svcs) {
                if (err) {
                    return next(err);
                }

                ctx.svcs = svcs;
                ctx.svcFromName = {};
                svcs.forEach(function (svc) {
                    ctx.svcFromName[svc.name] = svc;
                });

                next();
            });
        },

        function saveChangesToHistory(ctx, next) {
            ctx.svcs.forEach(function (svc) {
                if (svc.type === 'vm') {
                    changes.push({
                        service:  svc,
                        type: 'update-service-cfg'
                    });
                }
            });
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

        // Remove deprecated params.resolvers:
        function removeSdcAppResolvers(ctx, next) {
            if (!self.sdcadm.sdc.params.resolvers) {
                return next();
            }
            progress('Remove deprecated "sdc" SAPI app params resolvers');
            self.sdcadm.sapi.updateApplication(self.sdcadm.sdc.uuid, {
                action: 'delete',
                params: {
                    resolvers: []
                }
            }, function (err, app) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else {
                    next();
                }
            });

        },

        function updateSdcAppSchemas(ctx, next) {
            var currSchema = self.sdcadm.sdc.metadata_schema;
            var latestSchema = schemas.sdc.sdc_app;
            if (currSchema && jsprim.deepEqual(currSchema, latestSchema)) {
                return next();
            }

            self.log.debug({before: currSchema, after: latestSchema},
                'update sdc app metadata_schema');
            progress('Update "sdc" SAPI app metadata_schema');
            self.sdcadm.sapi.updateApplication(self.sdcadm.sdc.uuid, {
                action: 'update',
                metadata_schema: latestSchema
            }, function (err, app) {
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
                    return nextSvc();
                }
            }, next);
        },

        function updateServiceDomains(ctx, next) {
            var svcsToUpdate = [];
            NEW_SERVICES.forEach(function (svcName) {
                var svc = ctx.svcFromName[svcName];
                if (svc && svc.metadata && (
                    !svc.metadata.SERVICE_DOMAIN || !svc.metadata['sapi-url']))
                {
                    svcsToUpdate.push(svc);
                }
            });

            vasync.forEachParallel({
                inputs: svcsToUpdate,
                func: function updateSvc(svc, nextSvc) {
                    var mdata = self.sdcadm.sdc.metadata;
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
            var mdata = self.sdcadm.sdc.metadata;
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
                return next();
            }

            progress('Adding domain keys to "sdc" SAPI app metadata: %j',
                mdataUpdates);
            vasync.forEachParallel({
                inputs: ctx.svcs,
                func: function updateApp(svc, nextSvc) {
                    updateSdcApp({metadata: mdataUpdates}, nextSvc);
                }
            }, next);
        },

        function getSdc4096Pkg(ctx, next) {
            self.sdcadm.papi.list({
                owner_uuid: self.sdcadm.config.ufds_admin_uuid,
                name: 'sdc_4096',
                active: true
            }, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
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
                return next();
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

        function ensureDockerPkg_Svc(ctx, next) {
            var dockerSvc = ctx.svcFromName.docker;
            if (!dockerSvc || dockerSvc.params.billing_id === ctx.sdc_4096.uuid)
            {
                return next();
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
                return next();
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
                    return next(vmsErr);
                }

                var toResize = dockerVms.filter(function (vm) {
                    return vm.billing_id !== ctx.sdc_4096.uuid;
                });
                if (!toResize.length) {
                    return next();
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
                                    'InsufficientCapacity'))
                                {
                                    progress('Note: You can use ' +
                                        '"--force-resize" to override ' +
                                        '"InsufficientCapacity".');
                                }
                                return nextVm(new errors.SDCClientError(
                                    resizeErr, 'vmapi'));
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

        function updateRegionName(ctx, next) {
            var regionName;
            var keyInitiallyMounted;

            fs.readFile('/usbkey/config', {
                encoding: 'utf8'
            }, function (err, data) {
                if (err) {
                    return next(err);
                /* JSSTYLED */
                } else if (data.search(/region_name=/) !== -1) {
                    log.debug('region_name is up to date');
                    return next();
                }

                function readRegionName(_, next_) {
                    progress('Updating "region_name" for this data center');

                    var field = {
                        name: 'region_name',
                        hidden: false,
                        confirm: true
                    };
                    readField(field, function (err1, value) {
                        if (err1) {
                            return next_(err1);
                        }

                        regionName = value;
                        return next_();
                    });
                }

                function appendRegionName(_, next_) {
                    var region = 'region_name=' + regionName + '\n';
                    fs.appendFile('/mnt/usbkey/config', region,
                            function (err1) {
                        if (err1) {
                            return next_(err1);
                        }

                        var argv = [
                            '/usr/bin/cp',
                            '/mnt/usbkey/config',
                            '/usbkey/config'
                        ];
                        common.execFilePlus({argv: argv, log: self.log}, next_);
                    });
                }

                function updateSapiRegionName(_, next_) {
                    var metadata = { region_name: regionName };
                    updateSdcApp({ metadata: metadata }, next_);
                }

                function isKeyMounted(_, next_) {
                    common.isUsbKeyMounted(self.log, function (er, mounted) {
                        if (er) {
                            return next_(er);
                        }
                        keyInitiallyMounted = mounted;
                        return next_();
                    });
                }

                vasync.pipeline({funcs: [
                    readRegionName,
                    isKeyMounted,
                    function mountUsbKey(_, next2) {
                        if (keyInitiallyMounted) {
                            return next2();
                        }
                        common.mountUsbKey(self.log, next2);
                    },
                    appendRegionName,
                    function unmountUsbKey(_, next2) {
                        if (keyInitiallyMounted) {
                            return next2();
                        }
                        common.unmountUsbKey(self.log, next2);
                    },
                    updateSapiRegionName
                ]}, next);
            });
        },

        function addSapiDomainToNodeConfig(ctx, next) {
            var nodeConfig = '/usbkey/extra/joysetup/node.config';
            fs.readFile(nodeConfig, { encoding: 'utf8' }, function (err, data) {
                if (err) {
                    return next(err);
                /* JSSTYLED */
                } else if (data.search(/sapi_domain=/) !== -1) {
                    log.debug('sapi_domain already present on node.config');
                    return next();
                }

                progress('Appending "sapi_domain" to node.config');
                var mdata = self.sdcadm.sdc.metadata;
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

                    steps.updateSizeParameters({
                        progress: progress,
                        service: ctx.svcFromName[svcName],
                        log: self.log,
                        sdcadm: self.sdcadm,
                        params: updatedParams[svcName]
                    }, done);
                }
            }, next);
        },

        function runVmapiMigrations(ctx, next) {
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'vmapi',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                var vmapi = vms_[0];
                self.sdcadm.imgapi.getImage(vmapi.image_uuid,
                        function (imgErr, img) {
                    if (imgErr) {
                        return next(imgErr);
                    }
                    var parts = img.version.split('-');
                    var curImg = parts[parts.length - 2];
                    if (curImg >= '20141030T234934Z') {
                        progress('Running VMAPI migrations');
                        var argv = [
                            '/usr/sbin/zlogin',
                            vmapi.uuid,
                            'cd /opt/smartdc/vmapi && ./build/node/bin/node ' +
                                'tools/migrations/add-docker-index.js'
                        ];
                        common.spawnRun({argv: argv, log: log}, next);
                    } else {
                        return next();
                    }
                });
            });
        },

        function removeHostvolumeInstances(ctx, next) {
            if (!ctx.svcFromName.hostvolume) {
                return next();
            }

            self.sdcadm.sapi.listInstances({
                service_uuid: ctx.svcFromName.hostvolume.uuid
            }, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }

                if (!insts.length) {
                    return next();
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
                return next();
            }
            progress('Removing deprecated hostvolume service');
            self.sdcadm.sapi.deleteService(ctx.svcFromName.hostvolume.uuid,
                    function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                return next();
            });
        }
    ]}, function (err) {
        if (!history) {
            self.sdcadm.log.warn('History not set for update-other');
            return cb(err);
        }

        if (err) {
            history.error = err;
        }
        self.sdcadm.history.updateHistory(history, function (err2) {
            if (err) {
                return cb(err);
            }
            log.debug('done update-other successfully');
            if (err2) {
                return cb(err2);
            } else {
                return cb();
            }
        });
    });
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

// --- exports

module.exports = {
    do_update_other: do_update_other
};
