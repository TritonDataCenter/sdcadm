/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var util = require('util'),
    format = util.format;

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');
/*
 * The 'sdcadm experimental update-docker' CLI subcommand.
 */

/**
 * Update this SDC docker service setup:
 * - update docker0 to latest image, adding the 'docker' service to the 'sdc'
 *   app in SAPI if necessary. Limitations: Presumes only a single instance
 *   (docker0). Presumes docker0 is on the HN.
 * - hostvolume service and an instance on every CN (including the HN for now
 *   because we typically test with HN provisioning).
 * - nat service, and get latest image (instances are created)
 */

function do_update_docker(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (!opts.servers) {
        return cb(new errors.UsageError('"--servers SERVERS" must be ' +
            'specified (see --help output for more details)'));
    }

    var start = Date.now();
    var headnode;
    var dockerSvcData = {
        name: 'docker',
        params: {
            package_name: 'sdc_4096',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'},
                {name: 'external', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'docker',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'docker',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            USE_TLS: true,
            'user-script': 'TO_FILL_IN'
        }
    };

    var hostvolumeSvcData = {
        name: 'hostvolume',
        params: {
            package_name: 'sdc_4096',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            networks: [
                {name: 'external', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'hostvolume',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'hostvolume',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var natSvcData = {
        name: 'nat',
        params: {
            package_name: 'sdc_128',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            /*
             * Intentionally no 'networks' field. It is explicitly set for
             * 'nat' zone creation in
             * sdc-vmapi.git:lib/workflows/fabrics-common.js.
             */
            firewall_enabled: false,
            tags: {
                smartdc_role: 'nat',
                smartdc_type: 'core'
            }
        },
        metadata: {
            // Allow these keys to actually live in the zone's metadata,
            // rather than being populated by config-agent (which doesn't
            // exist in NAT zones):
            pass_vmapi_metadata_keys: [ 'com.joyent:ipnat_subnet' ],
            SERVICE_NAME: 'nat',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var context = {
        imgsToDownload: []
    };
    vasync.pipeline({arg: context, funcs: [
        /* @field ctx.dockerPkg */
        function getDockerPkg(ctx, next) {
            var filter = {name: dockerSvcData.params.package_name,
                active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            dockerSvcData.params.package_name)
                    }));
                }
                ctx.dockerPkg = pkgs[0];
                next();
            });
        },

        /* @field ctx.hostvolumePkg */
        function getHostvolumePkg(ctx, next) {
            var filter = {name: hostvolumeSvcData.params.package_name,
                active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            hostvolumeSvcData.params.package_name)
                    }));
                }
                ctx.hostvolumePkg = pkgs[0];
                next();
            });
        },

        /* @field ctx.natPkg */
        function getNatPkg(ctx, next) {
            var filter = {name: natSvcData.params.package_name, active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            natSvcData.params.package_name)
                    }));
                }
                ctx.natPkg = pkgs[0];
                next();
            });
        },

        function ensureSapiMode(_, next) {
            // Bail if SAPI not in 'full' mode.
            self.sdcadm.sapi.getMode(function (err, mode) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else if (mode !== 'full') {
                    next(new errors.UpdateError(format(
                        'SAPI is not in "full" mode: mode=%s', mode)));
                } else {
                    next();
                }
            });
        },

        function getSdcApp(ctx, next) {
            ctx.app = self.sdcadm.sdc;
            ctx.sdcadm = self.sdcadm;
            ctx.log = self.log;
            ctx.progress = self.progress;
            next();
        },

        /**
         * SDC Docker usage means biting the bullet and switching to the
         * "new" agents (cn-agent, vm-agent, net-agent) via the "no_rabbit"
         */
        steps.noRabbitEnable,

        function getDockerSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'docker',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.dockerSvc = svcs[0];
                }
                next();
            });
        },

        function getCloudapiSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cloudapi',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.cloudapiSvc = svcs[0];
                }
                next();
            });
        },

        function getHostvolumeSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'hostvolume',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.hostvolumeSvc = svcs[0];
                }
                next();
            });
        },

        function getNatSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'nat',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.natSvc = svcs[0];
                }
                next();
            });
        },

        /*
         * @field ctx.dockerInst
         * @field ctx.dockerVm
         */
        function getDockerInst(ctx, next) {
            if (!ctx.dockerSvc) {
                return next();
            }
            var filter = {
                service_uuid: ctx.dockerSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.dockerInst = insts[0];
                    self.sdcadm.vmapi.getVm({uuid: ctx.dockerInst.uuid},
                            function (vmErr, dockerVm) {
                        if (vmErr) {
                            return next(vmErr);
                        }
                        ctx.dockerVm = dockerVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },

        function getHostvolumeInsts(ctx, next) {
            if (!ctx.hostvolumeSvc) {
                ctx.hostvolumeInsts = [];
                return next();
            }
            var filter = {
                service_uuid: ctx.hostvolumeSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.hostvolumeInsts = insts;
                next();
            });
        },

        function getLatestDockerImage(ctx, next) {
            var filter = {name: 'docker'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.dockerImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "docker" image found'));
                }
            });
        },

        function getLatestHostvolumeImage(ctx, next) {
            var filter = {name: 'hostvolume'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.hostvolumeImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "hostvolume" image found'));
                }
            });
        },

        function getLatestNatImage(ctx, next) {
            var filter = {name: 'nat'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.natImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "nat" image found'));
                }
            });
        },

        function haveDockerImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.dockerImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.dockerImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function haveHostvolumeImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.hostvolumeImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.hostvolumeImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function haveNatImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.natImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.natImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        // Fail early when the provided servers value is incorrect
        function getServersNeedingHostvolume(ctx, next) {
            self.sdcadm.cnapi.listServers({}, function (err, allServers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }

                // Parse '--servers' opt args.
                var i;
                var requestedServers = {};
                for (i = 0; i < opts.servers.length; i++) {
                    opts.servers[i].split(/[, ]+/g).forEach(function (name) {
                        requestedServers[name] = true;
                    });
                }

                // Determine which server objects were selected for setup.
                var hostvolumeServers = [];
                if (requestedServers.cns) {
                    hostvolumeServers = allServers.filter(function (s) {
                        return (s.setup && s.status === 'running' &&
                            !s.headnode);
                    });
                    delete requestedServers.cns;
                }
                if (requestedServers.none) {
                    // Special 'none' value to allow specifying *no* servers.
                    delete requestedServers.none;
                }
                var serverFromHostname = {};
                var serverFromUuid = {};
                allServers.forEach(function (s) {
                    serverFromHostname[s.hostname] = s;
                    serverFromUuid[s.uuid] = s;
                });
                var unknownServers = [];
                Object.keys(requestedServers).forEach(function (name) {
                    if (serverFromUuid[name]) {
                        hostvolumeServers.push(serverFromUuid[name]);
                    } else if (serverFromHostname[name]) {
                        hostvolumeServers.push(serverFromHostname[name]);
                    } else {
                        unknownServers.push(name);
                    }
                });
                if (unknownServers.length > 0) {
                    return next(new Error('unknown servers: ' +
                        unknownServers.join(', ')));
                }

                // Determine which of those select don't have a hostvolume yet.
                var hostvolumeInstFromServer = {};
                ctx.hostvolumeInsts.forEach(function (inst) {
                    hostvolumeInstFromServer[inst.params.server_uuid] = inst;
                });
                ctx.serversWithNoHostvolumeInst = hostvolumeServers.filter(
                        function (s) {
                    return hostvolumeInstFromServer[s.uuid] === undefined;
                });
                if (ctx.serversWithNoHostvolumeInst.length > 0) {
                    var summary = ctx.serversWithNoHostvolumeInst.slice(0, 3)
                        .map(function (s) { return s.hostname; }).join(', ');
                    if (ctx.serversWithNoHostvolumeInst.length > 3) {
                        summary += ', ...';
                    }
                    self.progress('Found %d server(s) on which to create '
                        + 'a "hostvolume" instance: %s',
                        ctx.serversWithNoHostvolumeInst.length, summary);
                }
                next();
            });
        },

        function importImages(ctx, next) {
            if (ctx.imgsToDownload.length === 0) {
                return next();
            }
            var proc = new DownloadImages({images: ctx.imgsToDownload});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userString */
        shared.getUserScript,

        function createDockerSvc(ctx, next) {
            if (ctx.dockerSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = dockerSvcData.name + '.' + domain;

            self.progress('Creating "docker" service');
            dockerSvcData.params.image_uuid = ctx.dockerImg.uuid;
            dockerSvcData.metadata['user-script'] = ctx.userScript;
            dockerSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            dockerSvcData.params.billing_id = ctx.dockerPkg.uuid;
            delete dockerSvcData.params.package_name;

            if (ctx.app.metadata.fabric_cfg) {
                dockerSvcData.metadata.USE_FABRICS = true;
            }

            self.sdcadm.sapi.createService('docker', ctx.app.uuid,
                    dockerSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.dockerSvc = svc;
                self.log.info({svc: svc}, 'created docker svc');
                next();
            });
        },

        function createHostvolumeSvc(ctx, next) {
            if (ctx.hostvolumeSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = hostvolumeSvcData.name + '.' + domain;

            self.progress('Creating "hostvolume" service');
            hostvolumeSvcData.params.image_uuid = ctx.hostvolumeImg.uuid;
            hostvolumeSvcData.metadata['user-script'] = ctx.userScript;
            hostvolumeSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            hostvolumeSvcData.params.billing_id = ctx.hostvolumePkg.uuid;
            delete hostvolumeSvcData.params.package_name;

            self.sdcadm.sapi.createService('hostvolume', ctx.app.uuid,
                    hostvolumeSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.hostvolumeSvc = svc;
                self.log.info({svc: svc}, 'created hostvolume svc');
                next();
            });
        },

        function createNatSvc(ctx, next) {
            if (ctx.natSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = natSvcData.name + '.' + domain;

            self.progress('Creating "nat" service');
            natSvcData.params.image_uuid = ctx.natImg.uuid;
            natSvcData.metadata['user-script'] = ctx.userScript;
            natSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            natSvcData.params.billing_id = ctx.natPkg.uuid;
            delete natSvcData.params.package_name;

            self.sdcadm.sapi.createService('nat', ctx.app.uuid,
                    natSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.natSvc = svc;
                self.log.info({svc: svc}, 'created nat svc');
                next();
            });
        },
        function getHeadnode(_, next) {
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },
        function createDockerInst(ctx, next) {
            if (ctx.dockerInst) {
                return next();
            }
            self.progress('Creating "docker" instance');
            var instOpts = {
                params: {
                    alias: 'docker0',
                    delegate_dataset: true,
                    server_uuid: headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.dockerSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.newDockerInst = inst;
                next();
            });
        },

        /*
         * If not set, set the 'docker' key in CLOUDAPI_SERVICES
         * metadata on the cloudapi service. See "SAPI configuration" section
         * in "sdc-cloudapi.git:blob/master/docs/admin.restdown".
         */
        function updateCloudapiServicesMetadata(ctx, next) {
            var services;

            // Skip, if CLOUDAPI_SERVICES is already set.
            var existing = ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES;
            if (existing) {
                try {
                    services = JSON.parse(existing);
                } catch (ex) {
                    return next(new errors.InternalError({
                        message: format('unexpected non-JSON value for '
                            + 'cloudapi SAPI service "CLOUDAPI_SERVICES" '
                            + 'metadata: %j', existing)
                    }));
                }
                if (services.docker) {
                    return next();
                }
            }

            var dockerInst = ctx.newDockerInst || ctx.dockerInst;
            self.sdcadm.vmapi.getVm({uuid: dockerInst.uuid},
                    function (vmErr, dockerVm) {
                if (vmErr) {
                    return next(vmErr);
                }
                var dockerIp = dockerVm.nics.filter(function (nic) {
                    return nic.nic_tag === 'external';
                })[0].ip;
                var dockerUrl = format('tcp://%s:2376', dockerIp);

                try {
                    services = JSON.parse(
                        ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES || '{}');
                } catch (ex) {
                    return next(new errors.InternalError({
                        message: format('unexpected non-JSON value for '
                            + 'cloudapi SAPI service "CLOUDAPI_SERVICES" '
                            + 'metadata: %j',
                            ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES)
                    }));
                }
                self.progress('Update "docker" key in CLOUDAPI_SERVICES to',
                    dockerUrl);
                if (!services) {
                    services = {};
                }
                services.docker = dockerUrl;
                var update = {
                    metadata: {
                        CLOUDAPI_SERVICES: JSON.stringify(services)
                    }
                };
                self.sdcadm.sapi.updateService(ctx.cloudapiSvc.uuid, update,
                    errors.sdcClientErrWrap(next, 'sapi'));
            });
        },

        function createHostvolumeInsts(ctx, next) {
            if (ctx.serversWithNoHostvolumeInst.length === 0) {
                return next();
            }

            self.progress('Creating "hostvolume" instances on %d server(s)',
                ctx.serversWithNoHostvolumeInst.length);
            ctx.newHostvolumeInsts = [];
            vasync.forEachPipeline({
                inputs: ctx.serversWithNoHostvolumeInst,
                func: function createHostvolumeInst(server, nextServer) {
                    var instOpts = {
                        params: {
                            alias: 'hostvolume-' + server.hostname,
                            server_uuid: server.uuid
                        }
                    };
                    self.sdcadm.sapi.createInstance(ctx.hostvolumeSvc.uuid,
                            instOpts, function (err, inst) {
                        if (err) {
                            return next(new errors.SDCClientError(err, 'sapi'));
                        }
                        self.progress('Created VM %s (%s) on server %s',
                            inst.uuid, inst.params.alias, server.hostname);
                        ctx.newHostvolumeInsts.push(inst);
                        nextServer();
                    });
                }
            }, next);
        },

        function updateDockerSvcImageUuid(ctx, next) {
            if (!ctx.force &&
                ctx.dockerImg.uuid === ctx.dockerSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "docker" SAPI service',
                ctx.dockerImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.dockerImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.dockerSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function updateHostvolumeSvcImageUuid(ctx, next) {
            if (!ctx.force && ctx.hostvolumeImg.uuid ===
                ctx.hostvolumeSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "hostvolume" SAPI service',
                ctx.hostvolumeImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.hostvolumeImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.hostvolumeSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function updateNatSvcImageUuid(ctx, next) {
            if (!ctx.force &&
                ctx.natImg.uuid === ctx.natSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "nat" SAPI service',
                ctx.natImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.natImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.natSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function ensureDockerDelegateDataset(ctx, next) {
            if (ctx.newDockerInst) {
                return next();
            }

            shared.ensureDelegateDataset({
                service: dockerSvcData,
                progress: self.progress,
                zonename: ctx.dockerInst.uuid,
                log: self.log,
                server: ctx.dockerVm.server_uuid
            }, next);
        },

        function reprovisionDockerInst(ctx, next) {
            if (ctx.newDockerInst) {
                return next();
            } else if (!opts.force &&
                ctx.dockerVm.image_uuid === ctx.dockerImg.uuid) {
                return next();
            }
            self.progress('Reprovisioning "docker" instance %s (%s)',
                ctx.dockerVm.uuid, ctx.dockerVm.alias);
            self.sdcadm.sapi.reprovisionInstance(ctx.dockerInst.uuid,
                    ctx.dockerImg.uuid, function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Reprovisioned "docker" instance %s (%s)',
                    ctx.dockerVm.uuid, ctx.dockerVm.alias);
                next();
            });
        },

        function reprovisionHostvolumeInsts(ctx, next) {
            vasync.forEachPipeline({
                inputs: ctx.hostvolumeInsts,
                func: function reprovHostvolumeInst(inst, nextInst) {
                    // First get its current image from VMAPI to not reprov
                    // if not necessary.
                    self.sdcadm.vmapi.getVm({uuid: inst.uuid},
                            function (vmErr, vm) {
                        if (vmErr) {
                            return nextInst(vmErr);
                        } else if (vm.image_uuid === ctx.hostvolumeImg.uuid) {
                            return nextInst();
                        }
                        self.progress('Reprovisioning %s (%s) inst\n' +
                                common.indent('to image %s'),
                                inst.uuid, inst.params.alias,
                                ctx.hostvolumeImg.uuid);
                        self.sdcadm.sapi.reprovisionInstance(
                                inst.uuid,
                                ctx.hostvolumeImg.uuid, function (err) {
                            if (err) {
                                return nextInst(
                                    new errors.SDCClientError(err, 'sapi'));
                            }
                            self.progress('Reprovisioned %s (%s) inst\n' +
                                common.indent('to image %s'),
                                inst.uuid, inst.params.alias,
                                ctx.hostvolumeImg.uuid);
                            nextInst();
                        });
                    });
                }
            }, next);
        },

        function done(_, next) {
            self.progress('Updated SDC Docker (%ds)',
                Math.floor((Date.now() - start) / 1000));
            next();
        }
    ]}, cb);
}

do_update_docker.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Allow update to proceed even if already at latest image.'
    },
    {
        names: ['servers'],
        helpArg: 'SERVERS',
        type: 'arrayOfString',
        help: 'The servers to prepare for Docker containers. Currently this ' +
              'just means provisioning a "hostvolume" instance on that ' +
              'server. ' +
              'Pass in a comma- or space-separated list of server UUIDs or ' +
              'hostnames, or the special value "cns" which means all setup ' +
              'and running compute nodes (i.e. *excluding* the headnode). ' +
              'The special value "none" can also be used to allow (the rare ' +
              'case of) setting up for docker, but not yet setting up any ' +
              'CNs for docker containers. This option can be specified ' +
              'multiple times.'
    }
];
do_update_docker.help = (
    'Add/update the docker service.\n' +
    '\n' +
    'This includes: creating the "docker" SAPI service, creating or\n' +
    'updating the "docker0" instance (on the headnode), creating the\n' +
    '"hostvolume" service and creating an instance on each server,\n' +
    'creating the "nat" service and updating its image.\n' +
    '\n' +
    '(Note: The "nat" service management should move to a separate\n' +
    'command.)\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-docker\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'Examples:\n' +
    '     {{name}} update-docker --servers cns\n' +
    '     {{name}} update-docker --servers cns,headnode   # for dev in COAL\n'
);

// --- exports

module.exports = {
    do_update_docker: do_update_docker
};
