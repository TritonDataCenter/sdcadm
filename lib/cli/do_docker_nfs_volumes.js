/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * The 'sdcadm experimental docker-nfs-volumes' CLI subcommand.
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

function getImagesVersions(coreServicesNames, options, callback) {
    assert.arrayOfString(coreServicesNames, 'coreServicesNames');
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.func(callback, 'callback');

    var sdcadm = options.sdcadm;

    vasync.forEachParallel({
        func: function doGetCoreServiceImageVersion(coreServiceName, done) {
            sdcadm.getImgsForSvcVms({
                svc: coreServiceName
            }, function onGetImgForSvcVms(getErr, imgsForVms) {
                var res;

                if (!getErr) {
                    res = {
                        serviceName: coreServiceName,
                        images: imgsForVms.ims,
                        vms: imgsForVms.vms
                    };
                }

                done(getErr, res);
            });
        },
        inputs: coreServicesNames
    }, function onImagesVersions(err, results) {
        var idx = 0;
        var image;
        var serviceVersionInfo = [];
        var vm;

        if (!err) {
            results.successes.forEach(function flattenResults(result) {
                assert.arrayOfObject(result.images, 'result.images');
                assert.arrayOfObject(result.vms, 'result.vms');

                for (idx = 0; idx < result.images.length; ++idx) {
                    image = results.images[idx];
                    vm = results.vms[idx];

                    serviceVersionInfo.push({
                        serviceName: result.serviceName,
                        version: image.version,
                        vmUuid: vm.uuid
                    });
                }
            });
        }

        callback(err, results.successes);
    });
}

function updateSdcFlagInSapi(flagName, desiredValue, options, callback) {
    assert.string(flagName, 'flagName');
    assert.bool(desiredValue, 'desiredValue');
    assert.object(options, 'options');
    assert.object(options.sdcApp, 'options.sdcApp');
    assert.object(options.sapiClient, 'options.sapiClient');
    assert.func(callback, 'callback');

    var metadata = {};
    var sapiClient = options.sapiClient;
    var sdcApp = options.sdcApp;

    metadata[flagName] = desiredValue;

    sapiClient.updateApplication(sdcApp.uuid, metadata,
        function onSdcAppUpdated(sapiErr, updatedSdcAdpp) {
            callback(sapiErr,
                updatedSdcAdpp.metadata[flagName]);
        });
}

function do_docker_nfs_volumes(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var sapiFlagName = 'experimental_docker_nfs_shared_volumes';
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

            getImagesVersions(['docker', 'volapi', 'vmapi', 'workflow'], {
                sdcadm: self.sdcadm
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
                    var vmUuid = versionInfo.vmUuid;

                    assert.string(serviceName, 'serviceName');
                    assert.string(version, 'version');
                    assert.string(vmUuid, 'vmUuid');

                    self.progress('Checking VM ' + vmUuid + ' for service ' +
                        serviceName + ' at ' + 'version ' + version + ' is ' +
                        'up to date');

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
                return 'VM ' + versionInfo.vmUuid + ' for service ' +
                    versionInfo.serviceName + ' at version ' +
                    versionInfo.version;
            }

            next(err);
        },

        function updateDockerNfSharedVolumesFlag(ctx, next) {
            var desiredSapiFlagValue = true;
            if (opts.disable === true) {
                desiredSapiFlagValue = false;
            }

            self.progress('Checking if ' + sapiFlagName + '=' +
                desiredSapiFlagValue + ' in SDC app...');

            if (self.sdcadm.sdc.metadata[sapiFlagName] !==
                desiredSapiFlagValue) {
                ctx.didSomething = true;

                self.progress('Setting ' + sapiFlagName + ' to ' +
                    desiredSapiFlagValue + ' in SDC app...');

                updateSdcFlagInSapi(sapiFlagName, desiredSapiFlagValue, {
                    sdcApp: self.sdcadm.sdc,
                    sapiClient: self.sdcadm.sapi
                }, function _nfsSharedVolumesUpdated(err, result) {
                    var errMsg;

                    if (!err) {
                        if (result === desiredSapiFlagValue) {
                            self.progress(sapiFlagName + ' set to ' +
                                desiredSapiFlagValue + ' on SDC app');
                        } else {
                            errMsg = 'Could not set ' + sapiFlagName + ' to ' +
                                desiredSapiFlagValue + ' on SDC app';
                            self.progress(errMsg);
                            err = new Error(errMsg);
                        }
                    }

                    next(err);
                });
            } else {
                self.progress(sapiFlagName + ' already set to ' +
                    desiredSapiFlagValue + ', nothing to do');

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

do_docker_nfs_volumes.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Force enable/disable docker NFS volumes, regardless of ' +
            'prerequisites.'
    },
    {
        names: ['disable', 'd'],
        type: 'bool',
        help: 'Disable docker NFS volumes instead of enabling it'
    }
];

do_docker_nfs_volumes.help = (
    'Enables/disables support for docker NFS volumes.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} docker-nfs-volumes\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_docker_nfs_volumes: do_docker_nfs_volumes
};
