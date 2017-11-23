/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup volapi' CLI subcommand.
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
var steps = require('../steps');

var MBS_IN_GB = 1024;
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
    zfs_io_priority: 100,
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
    assert.arrayOfUuid(packageSettings.owner_uuids,
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
                    quota: packageSettings.size * MBS_IN_GB,
                    owner_uuids: packageSettings.owner_uuids
                };

                common.objCopy(NFS_SHARED_VOLUMES_PACKAGE_TEMPLATE, newPackage);
                cli.log.info({pkg: newPackage}, 'Adding package');

                papiClient.add(newPackage, function onPackageAdded(err, pkg) {
                    if (!err && pkg) {
                        ctx.pkgAdded = pkg;
                        cli.log.info({pkg: pkg}, 'Package added');
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
        sdcadm: self.sdcadm,
        devImgsToDownload: [],
        didSomething: false
    };

    assert.string(self.sdcadm.sdc.metadata.datacenter_name,
        'SDC application\'s metadata must have a "datacenter_name" property');
    assert.string(self.sdcadm.sdc.metadata.dns_domain,
        'SDC application\'s metadata must have a "dns_domain" property');

    var VOLAPI_DOMAIN = svcData.name + '.' +
        self.sdcadm.sdc.metadata.datacenter_name + '.' +
        self.sdcadm.sdc.metadata.dns_domain;

    vasync.pipeline({arg: context, funcs: [
        steps.sapiAssertFullMode,

        function getVolApiPkg(ctx, next) {
            var filter = {name: svcData.params.package_name,
                active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" active packages found',
                            pkgs.length, svcData.params.package_name)
                    }));
                }
                ctx.volapiPkg = pkgs[0];
                next();
            });
        },

        // First, update VOLAPI

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

        function haveLatestVolApiImageAlready(ctx, next) {
            self.progress('Latest "volapi" image is: ' + ctx.volapiImg.uuid);

            self.sdcadm.imgapi.getImage(ctx.volapiImg.uuid,
                    function (err, img) {
                if (err && err.body && err.body.code !== 'ResourceNotFound') {
                    next(err);
                    return;
                }

                if ((err && err.body && err.body.code === 'ResourceNotFound') ||
                    img === undefined || img === null) {
                    self.progress('Latest "volapi" image not found, ' +
                        'scheduling import');
                    ctx.volapiImgToDownload = ctx.volapiImg;
                } else {
                    self.progress('Latest "volapi" image already imported');
                }

                next();
            });
        },

        function importVolapiImage(ctx, next) {
            if (ctx.volapiImgToDownload === undefined) {
                return next();
            }

            var proc = new DownloadImages({
                images: [ctx.volapiImgToDownload]
            });

            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress,
                source: 'https://updates.joyent.com'
            }, next);
        },

        // Get the content for the user-script metadata entry used to create
        // instances of the VOLAPI service below in createVolApiSvc.
        shared.getUserScript,

        function getVolApiSvc(ctx, next) {
            self.progress('Getting volapi service...');

            self.sdcadm.sapi.listServices({
                name: 'volapi',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (svcs && svcs.length > 0) {
                    ctx.volapiSvc = svcs[0];
                }
                next();
            });
        },

        function updateVolApiSvc(ctx, next) {
            if (ctx.volapiSvc === undefined) {
                self.progress('volapi service doesn\'t exist');
                next();
                return;
            }

            self.progress('Checking if volapi service needs to be updated');

            if (ctx.volapiSvc.params.image_uuid !== ctx.volapiImg.uuid) {
                ctx.volapiSvc.params.image_uuid = ctx.volapiImg.uuid;
                self.progress('Updating "volapi" service');

                self.sdcadm.sapi.updateService(ctx.volapiSvc.uuid,
                    ctx.volapiSvc, next);
                return;
            } else {
                self.progress('Volapi service doesn\'t need to be updated');
                next();
                return;
            }
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
            self.sdcadm.getCurrServerUuid(function (err, hn) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.headnodeUuid = hn;
                next();
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

        function removeLeftoverVolapiInst(ctx, next) {
            var volapiVmDestroyed = ctx.volapiVm &&
                ctx.volapiVm.state === 'destroyed';

            if (ctx.volapiInst !== undefined && volapiVmDestroyed) {
                self.progress('Deleting leftover VOLAPI SAPI instance');
                self.sdcadm.sapi.deleteInstance(ctx.volapiInst.uuid,
                    function onSapiInstDeleted(err) {
                        if (err === undefined) {
                            self.progress('Leftover VOLAPI SAPI instance ' +
                                'deleted');
                        } else {
                            delete ctx.volapiInst;
                        }

                        next(err);
                    });
            } else {
                next();
            }
        },

        function createVolApiInst(ctx, next) {
            if (ctx.volapiInst !== undefined) {
                return next();
            }

            self.progress('Creating "volapi" instance');
            ctx.didSomething = true;

            var instOpts = {
                params: {
                    alias: 'volapi0',
                    server_uuid: ctx.headnodeUuid
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

        // NFS shared volumes zones use VMs to implement their underlying
        // storage. Each volume size is represented by a different package used
        // when provisioning these storage VMs. Thus these packages need to be
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
                    self.log.error({err: err}, 'Error when adding packages');
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
