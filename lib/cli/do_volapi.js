/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * The 'sdcadm experimental volapi' CLI subcommand.
 */

var assert = require('assert-plus');
var https = require('https');
var once = require('once');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');


var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');

var NB_MBS_IN_GB = 1024;
var NFS_SHARED_VOLUMES_PACKAGES_NAME_PREFIX = 'sdc_volume_nfs';
// Sizes are in GBs
var NFS_SHARED_VOLUMES_PKG_SIZES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
    200, 300, 400, 500, 600, 700, 800, 900, 1000];

/**
 * This is the template used for creating package objects for NFS shared
 * volumes. The size and owners' uuid are setup at runtime.
 */
var NFS_SHARED_VOLUMES_PACKAGE_TEMPLATE = {
    active: true,
    cpu_cap: 100,
    max_lwps: 1000,
    max_physical_memory: 256,
    max_swap: 256,
    vcpus: 1,
    version: '1.0.0',
    zfs_io_priority: 20,
    default: false
};

/**
 * Adds a package using PAPI client "papiClient" for shared NFS volumes of size
 * "size" GBs. Calls "callback" when done with an error object and the newly
 * created package as parameters.
 */
function addSharedVolumePackage(cli, packageSettings, callback) {
    assert.object(cli, 'cli');
    assert.object(packageSettings, 'packageSettings');
    assert.number(packageSettings.size, 'size');
    assert.arrayOfString(packageSettings.owner_uuids,
        'packageSettings.owner_uuids');
    assert.func(callback, 'callback');

    var papiClient = cli.sdcadm.papi;

    var packageName = [
        NFS_SHARED_VOLUMES_PACKAGES_NAME_PREFIX,
        packageSettings.size
    ].join('_');

    var context = {
        foundPackage: false
    };

    vasync.pipeline({
        funcs: [
            function _findPackage(ctx, next) {
                papiClient.list({name: packageName}, {},
                    function onPackagesListed(err, pkgs) {
                        if (!err && pkgs && pkgs.length > 0) {
                            ctx.foundPackage = true;
                        }

                        next(err);
                    });
            },
            function _addPackage(ctx, next) {
                if (ctx.foundPackage) {
                    next();
                    return;
                }

                var newPackage = {
                    name: packageName,
                    quota: packageSettings.size * NB_MBS_IN_GB,
                    owner_uuids: packageSettings.owner_uuids
                };

                common.objCopy(NFS_SHARED_VOLUMES_PACKAGE_TEMPLATE, newPackage);
                cli.log.info({pkg: newPackage}, 'Adding package');

                papiClient.add(newPackage, function onPackageAdded(err, pkg) {
                    if (!err && pkg) {
                        ctx.pkgAdded = pkg;
                        cli.log.info({package: pkg}, 'Package added');
                    }

                    next(err);
                });
            }
        ],
        arg: context
    }, function _addSharedVolumePackageDone(err) {
        callback(err, context.pkgAdded);
    });
}

function enableNfsSharedVolumesInDocker(dockerSvcId, options, callback) {
    assert.string(dockerSvcId, 'dockerSvcId');
    assert.object(options, 'options');
    assert.object(options.sapiClient, 'options.sapiClient');
    assert.func(callback, 'callback');

    var sapiClient = options.sapiClient;
    var context = {
        nfsSharedVolumesAlreadyEnabled: false,
        didEnableNfsSharedVolumes: false
    };

    vasync.pipeline({
        funcs: [
            function _checkAlreadyEnabled(ctx, next) {
                sapiClient.getService(dockerSvcId,
                    function _onGetDockerSvc(err, dockerSvc) {
                        var dockerSvcMetadata;
                        if (dockerSvc) {
                            dockerSvcMetadata = dockerSvc.metadata;
                        }

                        if (dockerSvcMetadata.experimental_nfs_shared_volumes) {
                            ctx.nfsSharedVolumesAlreadyEnabled = true;
                        }

                        next(err);
                    });
            },
            function _enableNfsSharedVolumes(ctx, next) {
                if (ctx.nfsSharedVolumesAlreadyEnabled) {
                    next();
                    return;
                }

                sapiClient.updateService(dockerSvcId, {
                    action: 'update',
                    metadata: {
                        experimental_nfs_shared_volumes: true
                    }
                }, function onDockerSvcUpdated(err) {
                    if (!err) {
                        ctx.didEnableNfsSharedVolumes = true;
                    }

                    next(err);
                });
            }
        ],
        arg: context
    }, function _updateDockerServiceDone(err) {
        callback(err, context.didEnableNfsSharedVolumes);
    });
}

function do_volapi(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var start = Date.now();
    var svcData = {
        name: 'volapi',
        params: {
            package_name: 'sdc_1024',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'volapi',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'volapi',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };


    var context = {
        devImgsToDownload: [],
        experimentalImgsToDownload: [],
        didSomething: false
    };

    assert.string(self.sdcadm.sdc.metadata.datacenter_name,
                    'SDC application\'s metadata must have a "datacenter_name" '
                        + 'property');
    assert.string(self.sdcadm.sdc.metadata.dns_domain,
                    'SDC application\'s metadata must have a "dns_domain" '
                        + 'property');

    var DC_DOMAIN = self.sdcadm.sdc.metadata.datacenter_name + '.' +
                    self.sdcadm.sdc.metadata.dns_domain;
    var VOLAPI_DOMAIN = svcData.name + '.' + DC_DOMAIN;

    vasync.pipeline({arg: context, funcs: [
        function getVolApiPkg(ctx, next) {
            var filter = {name: svcData.params.package_name,
                active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            svcData.params.package_name)
                    }));
                }
                ctx.volapiPkg = pkgs[0];
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

        // First, update VOLAPI, sdc-docker and nfs server zones images.

        function getLatestVolApiImage(ctx, next) {
            var filter = {name: 'volapi', channel: 'experimental'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.volapiImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "volapi" image found'));
                }
            });
        },

        function haveLatestVolApiImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.volapiImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    self.progress('Scheduling import of latest "volapi" '
                        + 'image');
                    ctx.experimentalImgsToDownload.push(ctx.volapiImg);
                } else if (err) {
                    return next(err);
                } else {
                    self.progress('Latest "volapi" image already imported');
                }

                next();
            });
        },

        function getLatestDockerApiImage(ctx, next) {
            var filter = {name: 'docker', channel: 'experimental'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                var tritonNfsImage;
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    images.forEach(function filterLatestTritonNfsImage(image) {
                        var imageIsNewer = tritonNfsImage === undefined ||
                            image.version > tritonNfsImage.version;

                        if (image.version.match('tritonnfs') && imageIsNewer) {
                            tritonNfsImage = image;
                        }
                    });

                    if (tritonNfsImage === undefined) {
                        next(new errors.UpdateError('no "docker" image found '
                            + 'for branch tritonnfs'));
                    } else {
                        ctx.latestDockerTritonNfsImg = tritonNfsImage;
                        next();
                    }

                } else {
                    next(new errors.UpdateError('no "docker" image found'));
                }
            });
        },

        function haveLatestDockerApiImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.latestDockerTritonNfsImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    self.progress('Scheduling import of latest "sdc-docker" '
                        + 'image');
                    ctx.experimentalImgsToDownload.push(
                        ctx.latestDockerTritonNfsImg);
                } else if (err) {
                    next(err);
                    return;
                } else {
                    self.progress('Latest "sdc-docker" image already imported');
                }

                next();
            });
        },

        function getLatestNfsServerZoneImage(ctx, next) {
            var filter = {name: 'nfsserver'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.latestNfsServerImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "nfserver" image found'));
                }
            });
        },

        function haveLatestNfsServerZoneImage(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.latestNfsServerImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    self.progress('Scheduling import of latest "nfsserver" '
                        + 'image');
                    ctx.devImgsToDownload.push(ctx.latestNfsServerImg);
                    next();
                } else if (err) {
                    next(err);
                } else {
                    self.progress('Latest "nfsserver" image already imported');
                    next();
                }
            });
        },

        // Import all latest images from the development channel (e.g the NFS
        // server zones' image) from the updates service to the local IMGAPI
        // service.
        function importDevImages(ctx, next) {
            if (ctx.devImgsToDownload.length === 0) {
                return next();
            }

            var proc = new DownloadImages({
                images: ctx.devImgsToDownload
            });

            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress,
                source: 'https://updates.joyent.com/?channel=dev'
            }, next);
        },

        // Import all latest images from the experimental channel (such as the
        // VOLAPI and sdc-docker services' images for the tritonnfs prototype)
        // from the updates service to the local IMGAPI service.
        function importExperimentalImages(ctx, next) {
            if (ctx.experimentalImgsToDownload.length === 0) {
                return next();
            }

            var proc = new DownloadImages({
                images: ctx.experimentalImgsToDownload
            });

            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress,
                source: 'https://updates.joyent.com/?channel=experimental'
            }, next);
        },

        // Get the content for the user-script metadata entry used to create
        // instances of the VOLAPI service below in createVolApiSvc.
        shared.getUserScript,

        function getVolApiSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'volapi',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.volapiSvc = svcs[0];
                }
                next();
            });
        },

        function createVolApiSvc(ctx, next) {
            if (ctx.volapiSvc) {
                return next();
            }

            self.progress('Creating "volapi" service');
            ctx.didSomething = true;

            svcData.params.image_uuid = ctx.volapiImg.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata['SERVICE_DOMAIN'] = VOLAPI_DOMAIN;
            svcData.params.billing_id = ctx.volapiPkg.uuid;
            delete svcData.params.package_name;

            self.sdcadm.sapi.createService('volapi', self.sdcadm.sdc.uuid,
                    svcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.volapiSvc = svc;
                self.log.info({svc: svc}, 'created volapi svc');
                next();
            });
        },

        // Get headnode's server UUID, which is needed to provision services
        // instances in next tasks below.
        function getHeadnode(ctx, next) {
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                ctx.headnode = servers[0];
                return next();
            });
        },

        function getVolApiInst(ctx, next) {
            // Here, either we had an existing VOLAPI service before the setup
            // process started, or we created one in createVolApiSvc, so there
            // has to be a VOLAPI service.
            assert.object(ctx.volapiSvc, 'ctx.volapiSvc');

            var filter = {
                service_uuid: ctx.volapiSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.volapiInst = insts[0];
                    self.sdcadm.vmapi.getVm({
                        uuid: ctx.volapiInst.uuid
                    }, function (vmErr, volapiVm) {
                        if (vmErr) {
                            return next(vmErr);
                        }
                        ctx.volapiVm = volapiVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },

        function createVolApiInst(ctx, next) {
            if (ctx.volapiInst) {
                return next();
            }

            self.progress('Creating "volapi" instance');
            ctx.didSomething = true;

            var instOpts = {
                params: {
                    alias: 'volapi0',
                    server_uuid: ctx.headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.volapiSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.newVolApiInst = inst;
                next();
            });
        },

        function addVolapiDomainToSdcApp(ctx, next) {
            if (self.sdcadm.sdc.metadata.volapi_domain === VOLAPI_DOMAIN) {
                next();
            } else {
                ctx.didSomething = true;
                self.progress('Adding volapi_domain to SDC application \'s '
                    + 'metadata');
                self.sdcadm.sapi.updateApplication(self.sdcadm.sdc.uuid, {
                    metadata: {
                        volapi_domain: VOLAPI_DOMAIN
                    }
                }, next);
            }
        },

        // NFS shared volumes zones use VMs to implement their underlying
        // storage. Each volume size is represented by a different package used
        // when provisioning these storage VMs. Thuse these packages need to be
        // added into PAPI before any NFS shared volume can be created.
        function addSharedVolumesPackages(ctx, next) {
            function createPackageSettings(packageSize) {
                assert.number(packageSize, 'packageSize');
                assert.ok(packageSize > 0);

                return {
                    size: packageSize,
                    owner_uuids: [self.sdcadm.config.ufds_admin_uuid]
                };
            }

            var packagesSettings =
                NFS_SHARED_VOLUMES_PKG_SIZES.map(createPackageSettings);

            vasync.forEachParallel({
                func: addSharedVolumePackage.bind(null, self),
                inputs: packagesSettings
            }, function sharedVolumesPackagesAdded(err, results) {
                if (err) {
                    self.log.error({error: err}, 'Error when adding packages');
                }

                var addedPackageNames = [];

                results.operations.forEach(function addPkgName(operation) {
                    if (operation.result) {
                        addedPackageNames.push(operation.result.name);
                    }
                });

                if (addedPackageNames.length > 0) {
                    self.progress('Added NFS shared volumes packages:\n'
                        + addedPackageNames.join('\n'));

                    ctx.didSomething = true;
                }

                next(err);
            });
        },

        // Now check if the current Docker API instance uses the latest version
        // of sdc-docker's tritonnfs branch.
        function getDockerApiSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'docker',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.dockerSvc = svcs[0];
                }

                next();
            });
        },

        function getDockerApiInst(ctx, next) {
            if (!ctx.dockerSvc) {
                next();
                return;
            }

            var filter = {
                service_uuid: ctx.dockerSvc.uuid
            };

            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    next(new errors.UpdateError('sapi error:', err));
                    return;
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.dockerInst = insts[0];
                    self.sdcadm.vmapi.getVm({
                        uuid: ctx.dockerInst.uuid
                    }, function (vmErr, dockerVm) {
                        if (vmErr) {
                            next(vmErr);
                            return;
                        }
                        ctx.dockerVm = dockerVm;
                        next();
                    });
                } else {
                    next(new errors.UpdateError('Could not find existing '
                        + 'docker instance'));
                }
            });
        },

        function getDockerImgInstalledVersion(ctx, next) {
            self.sdcadm.vmapi.getVm({uuid: ctx.dockerVm.uuid},
                function onGetVm(err, vm) {
                    if (vm) {
                        ctx.dockerInstalledImgUuid = vm.image_uuid;
                    }

                    next(err);
                });
        },

        // If the Docker API instance doesn't use the latest version of
        // sdc-docker's tritonnfs image, then update it.
        function updateDockerToTritonNfsImage(ctx, next) {
            if (ctx.dockerInstalledImgUuid !==
                ctx.latestDockerTritonNfsImg.uuid) {
                self.progress('Updating docker instance to latest tritonnfs '
                    + 'version...');
                ctx.didSomething = true;
                self.sdcadm.sapi.reprovisionInstance(ctx.dockerVm.uuid,
                    ctx.latestDockerTritonNfsImg.uuid, next);
            } else {
                next();
            }
        },

        // Once the update is done, wait until the Docker API service is
        // actually up to enable NFS shared volumes support.
        function getDockerApiHostAndPort(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cloudapi',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                var DOCKER_ENDPOINT_REGEXP = /^tcp:\/\/([\w\.\-\_]+):(\d+)$/;
                var cloudApiSvc, cloudApiSvcMetadata;
                var cloudApiServices;
                var dockerApiTcpEndpoint;
                var matches;

                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    cloudApiSvc = svcs[0];
                } else {
                    next(new Error('could not find CloudAPI service'));
                    return;
                }

                assert.object(cloudApiSvc, 'cloudApiSvc');
                assert.object(cloudApiSvc.params, 'cloudApiSvc.params');

                cloudApiSvcMetadata = cloudApiSvc.metadata;
                if (cloudApiSvcMetadata &&
                    cloudApiSvcMetadata.CLOUDAPI_SERVICES)  {
                    try {
                        cloudApiServices =
                            JSON.parse(cloudApiSvcMetadata.CLOUDAPI_SERVICES);
                    } catch (parseError) {
                        next(new errors.UpdateError('Could not parse '
                            + 'CLOUDAPI_SERVICES metadata'));
                        return;
                    }
                } else {
                    next(new errors.UpdateError('Could not find '
                        + 'CLOUDAPI_SERVICES metadata'));
                    return;
                }

                dockerApiTcpEndpoint = cloudApiServices.docker;
                assert.optionalString(dockerApiTcpEndpoint,
                    'dockerApiTcpEndpoint');
                if (dockerApiTcpEndpoint && dockerApiTcpEndpoint.length > 0) {
                    matches =
                        dockerApiTcpEndpoint.match(DOCKER_ENDPOINT_REGEXP);
                    if (matches) {
                        ctx.dockerApiHost = matches[1];
                        ctx.dockerApiPort = Number(matches[2]);
                    } else {
                        next(new errors.UpdateError('could not parse Docker '
                            + 'API host and port'));
                        return;
                    }
                }

                next();
            });
        },

        function pingDockerService(ctx, next) {
            assert.string(ctx.dockerApiHost, 'ctx.dockerApiHost');
            assert.number(ctx.dockerApiPort, 'ctx.dockerApiPort');

            var nbRetries = 0;
            var nbMaxRetries = 10;

            function ping() {
                var dockerPingRequestOpts;
                var dockerPingRequest;
                var reschedulePingOnce = once(reschedulePing);

                ++nbRetries;

                if (nbRetries > nbMaxRetries) {
                    next(new errors.UpdateError('Timed out when waiting for '
                        + 'docker service to come up'));
                    return;
                } else {
                    dockerPingRequestOpts = {
                        hostname: ctx.dockerApiHost,
                        port: ctx.dockerApiPort,
                        method: 'GET',
                        path: '/_ping',
                        rejectUnauthorized: false
                    };

                    self.progress('Pinging Docker API at https://'
                        + ctx.dockerApiHost + ':'
                        + ctx.dockerApiPort + '/_ping');

                    dockerPingRequest = https.request(dockerPingRequestOpts,
                        function onDockerApiPing(res) {
                            var dockerPingResponseBody = '';

                            function clearResponseEventListeners() {
                                res.removeListener('end', onPingResEnd);
                                res.removeListener('error', onPingResError);
                                res.removeListener('data', onPingResData);
                            }

                            function onPingResEnd() {
                                if (dockerPingResponseBody === 'OK') {
                                    self.progress('Got OK ping response!');
                                    next();
                                } else {
                                    clearResponseEventListeners();
                                    reschedulePingOnce(2000);
                                }
                            }

                            function onPingResData(data) {
                                dockerPingResponseBody += data.toString();
                            }

                            function onPingResError(err) {
                                clearResponseEventListeners();
                                reschedulePingOnce(2000);
                            }

                            res.on('data', onPingResData);
                            res.on('end', onPingResEnd);
                            res.on('error', onPingResError);
                        });

                    dockerPingRequest.on('error',
                        function onDockerPingError(err) {
                            reschedulePingOnce(2000);
                        });

                    dockerPingRequest.end();
                }
            }

            function reschedulePing(delay) {
                assert.number(delay, 'delay');

                setTimeout(function onRetryTimeout() {
                    ping();
                }, delay);
            }

            ping();
        },

        // Currently, NFS shared volumes are still at the prototype stage, and
        // they must be enabled by setting a SAPI configuration flag.
        function enableNfSharedVolumes(ctx, next) {
            function _nfsSharedVolumesEnabled(err, didEnable) {
                if (didEnable) {
                    self.progress('Set experimental_nfs_shared_volumes=true on '
                        + 'Docker service');
                    ctx.didSomething = true;
                }

                next(err);
            }

            enableNfsSharedVolumesInDocker(ctx.dockerSvc.uuid, {
                sapiClient: self.sdcadm.sapi
            }, _nfsSharedVolumesEnabled);
        },

        function done(ctx, next) {
            if (ctx.didSomething) {
                self.progress('Setup "volapi" (%ds)',
                    Math.floor((Date.now() - start) / 1000));
            } else {
                self.progress('"volapi" is already set up');
            }

            next();
        }
    ]}, cb);
}

do_volapi.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_volapi.help = (
    'Create the "volapi" service and a first instance.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} volapi\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_volapi: do_volapi
};
