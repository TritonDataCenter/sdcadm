/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * The 'sdcadm experimental nfs-volumes' CLI subcommand.
 *
 * Currently, NFS shared volumes are still at the prototype stage, and
 * they must be enabled/disabled by setting a SAPI configuration flag.
 */

var assert = require('assert-plus');
var https = require('https');
var once = require('once');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');


var common = require('../common');
var errors = require('../errors');
var shared = require('../procedures/shared');
var uuid = require('../uuid');

function getCoreServiceImageVersion(coreServiceName, options, callback) {
    assert.string(coreServiceName, 'coreServiceName');
    assert.object(options, 'options');
    assert.object(options.imgapiClient, 'options.imgapiClient');
    assert.object(options.sapiClient, 'options.sapiClient');
    assert.object(options.sdcApplication, 'options.sdcApplication');
    assert.object(options.vmapiClient, 'options.vmapiClient');
    assert.func(callback, 'callback');

    var context = {};
    var imgapiClient = options.imgapiClient;
    var sapiClient = options.sapiClient;
    var sdcApp = options.sdcApplication;
    var vmapiClient = options.vmapiClient;

    vasync.pipeline({arg: context, funcs: [
        function getSvc(ctx, next) {
            sapiClient.listServices({
                name: coreServiceName,
                application_uuid: sdcApp.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (svcs && svcs.length > 0) {
                    ctx.svc = svcs[0];
                }
                next();
            });
        },

        function getInst(ctx, next) {
            assert.object(ctx.svc, 'ctx.svc');

            var filter = {
                service_uuid: ctx.svc.uuid
            };

            sapiClient.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.inst = insts[0];
                    vmapiClient.getVm({
                        uuid: ctx.inst.uuid
                    }, function (vmErr, instVm) {
                        if (vmErr) {
                            return next(vmErr);
                        }

                        ctx.instVm = instVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },
        function getInstImage(ctx, next) {
            assert.object(ctx.instVm, 'ctx.instVm');

            if (!uuid.validUuid(ctx.instVm.image_uuid)) {
                next(new Error('VM for service ' + coreServiceName + ' has ' +
                    'an invalid image_uuid: ' + ctx.instVm.image_uuid));
                return;
            }

            imgapiClient.getImage(ctx.instVm.image_uuid,
                function onGetImg(getImgErr, img) {
                    ctx.img = img;
                    next(getImgErr);
                });
        }
    ]}, function onDone(err) {
        callback(err, {
            serviceName: coreServiceName,
            version: context.img.version
        });
    });

}

function getImagesVersions(coreServicesNames, options, callback) {
    assert.arrayOfString(coreServicesNames, 'coreServicesNames');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    vasync.forEachParallel({
        func: function doGetCoreServiceImageVersion(coreServiceName, done) {
            getCoreServiceImageVersion(coreServiceName, options, done);
        },
        inputs: coreServicesNames
    }, function onImagesVersions(err, results) {
        callback(err, results.successes);
    });
}

function updateNfsSharedVolumesInSdc(desiredValue, options, callback) {
    assert.bool(desiredValue, 'desiredValue');
    assert.object(options, 'options');
    assert.object(options.sdcApp, 'options.sdcApp');
    assert.object(options.sapiClient, 'options.sapiClient');
    assert.func(callback, 'callback');

    var sapiClient = options.sapiClient;
    var sdcApp = options.sdcApp;

    sapiClient.updateApplication(sdcApp.uuid, {
        metadata: {
            experimental_nfs_shared_volumes: desiredValue
        }
    }, function onSdcAppUpdated(sapiErr, updatedSdcAdpp) {
        callback(sapiErr,
            updatedSdcAdpp.metadata.experimental_nfs_shared_volumes);
    });
}

function do_nfs_volumes(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var start = Date.now();

    var context = {
        didSomething: false
    };

    vasync.pipeline({arg: context, funcs: [
        function getDependenciesImageVersions(ctx, next) {
            if (opts.force === true) {
                next();
                return;
            }

            if (opts.disable === true) {
                next();
                return;
            }

            self.progress('Getting dependencies versions...');

            /*
             * We don't need to check for versions of CloudAPI and sdc-docker
             * services since not updating them to a version that does not
             * support NFS volumes has no impact on other services.
             */
            getImagesVersions(['volapi', 'vmapi', 'workflow'], {
                imgapiClient: self.sdcadm.imgapi,
                sapiClient: self.sdcadm.sapi,
                sdcApplication: self.sdcadm.sdc,
                vmapiClient: self.sdcadm.vmapi
            }, function onGotImagesVersions(getImgVersErr, imagesVersions) {
                if (!getImgVersErr) {
                    self.progress('Got dependencies versions!');
                }

                ctx.imagesVersions = imagesVersions;
                next(getImgVersErr);
            });
        },

        function checkAllDependencies(ctx, next) {
            var err;
            var outdatedVersions;

            if (opts.force === true) {
                next();
                return;
            }

            if (opts.disable === true) {
                next();
                return;
            }

            assert.arrayOfObject(ctx.imagesVersions, 'ctx.imagesVersions');

            self.progress('Checking dependencies are up to date');

            outdatedVersions =
                ctx.imagesVersions.filter(function filterOutdated(versionInfo) {
                    var serviceName = versionInfo.serviceName;
                    var version = versionInfo.version;

                    assert.string(serviceName, 'serviceName');
                    assert.string(version, 'version');

                    self.progress('Checking service ' + serviceName + ' at ' +
                        'version ' + version + ' is up to date');

                    /*
                     * When this is submitted to be merged in master, this
                     * ^tritonnfs pattern needs to be updated to a different
                     * test that checks that "version" represents a version that
                     * is at least as recent as the first build of the
                     * corresponding service with NFS volumes support.
                     */
                    if (/^tritonnfs/.test(version)) {
                        return false;
                    }

                    return true;
                });

            if (outdatedVersions && outdatedVersions.length > 0) {
                err = new Error('Found outdated core services: ' +
                    outdatedVersions.map(renderVersionInfo).join(', '));
            }

            function renderVersionInfo(versionInfo) {
                return versionInfo.serviceName + ' at version ' +
                    versionInfo.version;
            }

            next(err);
        },

        function updateNfSharedVolumesFlag(ctx, next) {
            var desiredNfsSharedVolumesFlagValue = true;
            if (opts.disable === true) {
                desiredNfsSharedVolumesFlagValue = false;
            }

            self.progress('Checking if experimental_nfs_shared_volumes=' +
                desiredNfsSharedVolumesFlagValue + ' in SDC app...');

            if (self.sdcadm.sdc.metadata.experimental_nfs_shared_volumes !==
                desiredNfsSharedVolumesFlagValue) {
                ctx.didSomething = true;

                self.progress('Setting experimental_nfs_shared_volumes to ' +
                    desiredNfsSharedVolumesFlagValue + ' in SDC app...');

                updateNfsSharedVolumesInSdc(desiredNfsSharedVolumesFlagValue, {
                    sdcApp: self.sdcadm.sdc,
                    sapiClient: self.sdcadm.sapi
                }, function _nfsSharedVolumesUpdated(err, result) {
                    var errMsg;

                    if (!err) {
                        if (result === desiredNfsSharedVolumesFlagValue) {
                            self.progress('experimental_nfs_shared_volumes ' +
                                'set to ' + desiredNfsSharedVolumesFlagValue +
                                ' on SDC app');
                        } else {
                            errMsg = 'Could not set ' +
                                'experimental_nfs_shared_volumes to ' +
                                desiredNfsSharedVolumesFlagValue + ' on SDC ' +
                                'app';
                            self.progress(errMsg);
                            err = new Error(errMsg);
                        }
                    }

                    next(err);
                });
            } else {
                self.progress('experimental_nfs_shared_volumes already set ' +
                    'to ' + desiredNfsSharedVolumesFlagValue + ', nothing ' +
                    'to do');

                next();
            }
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

do_nfs_volumes.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Force enable/disable NFS volumes, regardless of prerequisites.'
    },
    {
        names: ['disable', 'd'],
        type: 'bool',
        help: 'Disable NFS volumes instead of enabling it'
    }
];

do_nfs_volumes.help = (
    'Enables/disables support for NFS volumes.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} nfs_volumes\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_nfs_volumes: do_nfs_volumes
};
