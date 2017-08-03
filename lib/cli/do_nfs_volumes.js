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
                        images: imgsForVms.imgs,
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
                    image = result.images[idx];
                    vm = result.vms[idx];

                    serviceVersionInfo.push({
                        serviceName: result.serviceName,
                        version: image.version,
                        vmUuid: vm.uuid
                    });
                }
            });
        }

        callback(err, serviceVersionInfo);
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

    sapiClient.updateApplication(sdcApp.uuid, {metadata: metadata},
        function onSdcAppUpdated(sapiErr, updatedSdcAdpp) {
            callback(sapiErr,
                updatedSdcAdpp.metadata[flagName]);
        });
}

function validFeatureName(featureName) {
    assert.string(featureName, 'featureName');

    var VALID_FEATURE_NAMES =
        [ 'docker', 'docker-automount', 'cloudapi', 'cloudapi-automount'];
    if (VALID_FEATURE_NAMES.indexOf(featureName) !== -1) {
        return true;
    }

    return false;
}

function validateArgs(args) {
    assert.optionalArrayOfString(args, 'args');

    if (!args || args.length < 1) {
        return new errors.UsageError('one argument is required');
    } else if (args.length > 1) {
        return new errors.UsageError('too many args: ' + args);
    } else if (!validFeatureName(args[0])) {
        return new errors.UsageError('invalid feature name: ' + args[0]);
    } else {
        return undefined;
    }
}

function getSapiFlagForFeatureName(featureName) {
    assert.string(featureName, 'featureName');

    var featureNameToSapiFlag = {};

    featureNameToSapiFlag['docker'] = 'experimental_docker_nfs_shared_volumes';
    featureNameToSapiFlag['docker-automount'] =
        'experimental_docker_automount_nfs_shared_volumes';
    featureNameToSapiFlag['cloudapi'] =
        'experimental_cloudapi_nfs_shared_volumes';
    featureNameToSapiFlag['cloudapi-automount'] =
        'experimental_cloudapi_automount_nfs_shared_volumes';

    return featureNameToSapiFlag[featureName];
}

function do_nfs_volumes(subcmd, opts, args, cb) {
    var self = this;
    var argsErr;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else {
        argsErr = validateArgs(args);
        if (argsErr) {
            cb(argsErr);
            return;
        }
    }

    var context = {
        didSomething: false
    };
    var featureName = args[0];
    var imageDeps = {};
    var sapiFlagName = getSapiFlagForFeatureName(featureName);

    /*
     * When this is submitted to be merged in master, the /tritonnfs/ tests
     * below will bebe updated to a different test that checks that "version"
     * represents a version that is at least as recent as the first build of the
     * corresponding service with NFS volumes support.
     */
    if (featureName === 'docker' || featureName === 'cloudapi') {
        imageDeps = {
            vmapi: function checkVmapiVersion(version) {
                return /tritonnfs/.test(version);
            },
            workflow: function checkWorkflowVersion(version) {
                return /tritonnfs/.test(version);
            },
            volapi: function checkVolapiVersion(version) {
                return /tritonnfs/.test(version);
            }
        };

        if (featureName === 'docker') {
            imageDeps.docker = function checkDockerVersion(version) {
                return /tritonnfs/.test(version);
            };
        } else {
            imageDeps.cloudapi = function checkCloudapiVersion(version) {
                return /tritonnfs/.test(version);
            };
        }
    }

    vasync.pipeline({arg: context, funcs: [
        function getDependenciesImageVersions(ctx, next) {
            var imgDepsNames = Object.keys(imageDeps);
            if (opts.force === true) {
                next();
                return;
            }

            if (opts.disable === true) {
                next();
                return;
            }

            if (!imgDepsNames || imgDepsNames.length === 0) {
                self.progress('Feature ' + featureName + ' has no image ' +
                    'dependencies');
                next();
                return;
            }

            self.progress('Getting versions for image dependencies: ' +
                imgDepsNames.join(', '));

            getImagesVersions([imgDepsNames], {
                sdcadm: self.sdcadm
            }, function onGotImagesVersions(getImgVersErr, imagesVersions) {
                var outdatedVersionsErr;
                var outdatedVersions;

                if (getImgVersErr) {
                    next(getImgVersErr);
                    return;
                }

                assert.arrayOfObject(imagesVersions, 'imagesVersions');

                self.progress('Checking dependencies are up to date');

                outdatedVersions =
                    imagesVersions.filter(function filterOutdated(versionInfo) {
                        var serviceName = versionInfo.serviceName;
                        var version = versionInfo.version;
                        var vmUuid = versionInfo.vmUuid;

                        assert.string(serviceName, 'serviceName');
                        assert.string(version, 'version');
                        assert.string(vmUuid, 'vmUuid');
                        assert.func(imageDeps[serviceName],
                                'imageDeps[' + serviceName + ']');

                        self.progress('Checking VM ' + vmUuid + ' for ' +
                            'service ' + serviceName + ' at ' + 'version ' +
                            version + ' is up to date');

                        return imageDeps[serviceName](version);
                    });

                if (outdatedVersions && outdatedVersions.length > 0) {
                    outdatedVersionsErr =
                        new Error('Found outdated core services: ' +
                            outdatedVersions.map(renderVersionInfo).join(', '));
                }

                function renderVersionInfo(versionInfo) {
                    return 'VM ' + versionInfo.vmUuid + ' for service ' +
                        versionInfo.serviceName + ' at version ' +
                        versionInfo.version;
                }

                next(outdatedVersionsErr);
            });
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
                if (opts.disable) {
                    self.progress('Disabled ' + featureName +
                        ' NFS volumes support');
                } else {
                    self.progress('Enabled ' + featureName +
                        ' NFS volumes support');
                }
            } else {
                if (opts.disable) {
                    self.progress(featureName +
                        ' NFS volumes support already disabled');
                } else {
                    self.progress(featureName +
                        ' NFS volumes support already enabled');
                }
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
        help: 'Force enable/disable a given NFS volumes feature, regardless ' +
            'of prerequisites.'
    },
    {
        names: ['disable', 'd'],
        type: 'bool',
        help: 'Disable a given docker NFS volume feature instead of enabling it'
    }
];

do_nfs_volumes.help = (
    'Enables/disables support for various NFS volumes features.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} nfs-volumes [docker|docker-automount|cloudapi|' +
        'cloudapi-automount]\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_nfs_volumes: do_nfs_volumes
};
