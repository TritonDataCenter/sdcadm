/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var util = require('util'),
    format = util.format;

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');

/**
 * SDC docker service setup
 */

function do_docker(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
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
            dockerSvcData.metadata.SERVICE_DOMAIN = svcDomain;
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
                        message: format('unexpected non-JSON value for ' +
                            'cloudapi SAPI service "CLOUDAPI_SERVICES" ' +
                            'metadata: %j', existing)
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
                        message: format('unexpected non-JSON value for ' +
                            'cloudapi SAPI service "CLOUDAPI_SERVICES" ' +
                            'metadata: %j',
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

        function done(_, next) {
            self.progress('Updated SDC Docker (%ds)',
                Math.floor((Date.now() - start) / 1000));
            next();
        }
    ]}, cb);
}

do_docker.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_docker.help = (
    'Create the docker service and the docker instance on the headnode.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} docker\n' +
    '\n' +
    '{{options}}' +
    '\n'
);

// --- exports

module.exports = {
    do_docker: do_docker
};
