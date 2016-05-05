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
    max_physical_memory: 1024,
    max_swap: 1024,
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
        imgsToDownload: [],
        didSomething: false
    };

    vasync.pipeline({arg: context, funcs: [
        function getPkg(ctx, next) {
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

        function getSvc(ctx, next) {
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

        function getVolApiInst(ctx, next) {
            if (!ctx.volapiSvc) {
                return next();
            }
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

        function getLatestVolApiImage(ctx, next) {
            var filter = {name: 'volapi'};
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

        function haveVolApiImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.volapiImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.volapiImg);
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
            var proc = new DownloadImages({
                images: ctx.imgsToDownload,
                source: opts['img-source']
            });
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userString */
        shared.getUserScript,

        function createVolApiSvc(ctx, next) {
            if (ctx.volapiSvc) {
                return next();
            }

            var domain = self.sdcadm.sdc.metadata.datacenter_name + '.' +
                    self.sdcadm.sdc.metadata.dns_domain;
            var svcDomain = svcData.name + '.' + domain;

            self.progress('Creating "volapi" service');
            ctx.didSomething = true;

            svcData.params.image_uuid = ctx.volapiImg.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata['SERVICE_DOMAIN'] = svcDomain;
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

        /* @field ctx.headnode */
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
        function getDockerServiceUuid(ctx, next) {
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
