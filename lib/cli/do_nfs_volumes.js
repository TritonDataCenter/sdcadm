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
 * their associated features must be enabled/disabled by setting various SAPI
 * configuration flags.
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

var FEATURE_NAME_TO_SAPI_FLAG = {
    'cloudapi': 'experimental_cloudapi_nfs_shared_volumes',
    'cloudapi-automount': 'experimental_cloudapi_automount_nfs_shared_volumes',
    'docker': 'experimental_docker_nfs_shared_volumes',
    'docker-automount': 'experimental_docker_automount_nfs_shared_volumes'
};

function getImagesVersions(coreServicesNames, options, callback) {
    assert.arrayOfString(coreServicesNames, 'coreServicesNames');
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.func(callback, 'callback');

    var sdcadm = options.sdcadm;

    vasync.forEachParallel({
        func: function doGetCoreServiceImageVersion(coreServiceName, next) {
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

                next(getErr, res);
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
        [ 'cloudapi', 'cloudapi-automount', 'docker', 'docker-automount'];
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

function versionSeemsGreaterOrEqualThan(versionInfoA, versionInfoB) {
    assert.object(versionInfoA, 'versionInfoA');
    assert.string(versionInfoA.branch, 'versionInfoA.branch');
    assert.string(versionInfoA.timestamp, 'versionInfoA.timestamp');
    assert.string(versionInfoA.commit, 'versionInfoA.commit');
    assert.object(versionInfoB, 'versionInfoB');
    assert.string(versionInfoB.branch, 'versionInfoB.branch');
    assert.string(versionInfoB.timestamp, 'versionInfoB.timestamp');
    assert.string(versionInfoB.commit, 'versionInfoB.commit');

    if (versionInfoA.branch !== versionInfoB.branch) {
        return false;
    }

    if (versionInfoA.timestamp < versionInfoB.timestamp) {
        return false;
    }

    if (versionInfoA.timestamp === versionInfoB.timestamp &&
        versionInfoA.commit !== versionInfoB.commit) {
        return false;
    }

    return true;
}

function versionInfoToString(versionInfo) {
    assert.object(versionInfo, 'versionInfo');
    assert.string(versionInfo.branch, 'versionInfo.branch');
    assert.string(versionInfo.timestamp, 'versionInfo.timestamp');
    assert.string(versionInfo.commit, 'versionInfo.commit');

    return [
        versionInfo.branch,
        versionInfo.timestamp,
        versionInfo.commit
    ].join('-');
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
    var featureDeps;
    var featureName = args[0];
    var imageDeps = {};
    var platformVersionDep;
    var sapiFlagName = FEATURE_NAME_TO_SAPI_FLAG[featureName];

    /*
     * When this is submitted to be merged in master, the /tritonnfs/ tests
     * below will be updated to a different test that checks that "version"
     * represents a version that is at least as recent as the first build of the
     * corresponding service with NFS volumes support.
     */
    if (featureName === 'docker' || featureName === 'cloudapi') {
        imageDeps = {
            vmapi: {
                branch: 'tritonnfs',
                timestamp: '20170907T220912Z',
                commit: 'g5041283'
            },
            workflow: {
                branch: 'tritonnfs',
                timestamp: '20170808T230958Z',
                commit: 'g5325c0b'
            },
            volapi: {
                branch: 'master',
                timestamp: '20170913T143055Z',
                commit: 'g047ee55'
            }
        };

        if (featureName === 'docker') {
            imageDeps.docker = {
                branch: 'tritonnfs',
                timestamp: '20170907T215559Z',
                commit: 'g681c787'
            };
        } else {
            imageDeps.cloudapi = {
                branch: 'tritonnfs',
                timestamp: '20170907T220711Z',
                commit: 'g8150066'
            };
        }
    }

    if (featureName === 'docker-automount') {
        platformVersionDep = '20160613T123039Z';
        /*
         * It doesn't make sense to enable the docker automount feature if NFS
         * volumes are not enabled for the docker service.
         */
        featureDeps = ['docker'];
    }

    if (featureName === 'cloudapi-automount') {
        // first version with smartos-live changes for automounting LX + SmartOS
        platformVersionDep = '20170925T211846Z';
        /*
         * It doesn't make sense to enable the cloudapi automount feature if NFS
         * volumes are not enabled for the cloudapi service.
         */
        featureDeps = ['cloudapi'];
    }

    vasync.pipeline({arg: context, funcs: [
        function checkFeatureDeps(ctx, next) {
            var err;
            var missingFeatureDeps;
            var sdcApp = self.sdcadm.sdc;

            if (opts.force === true) {
                next();
                return;
            }

            if (opts.disable === true) {
                next();
                return;
            }

            if (featureDeps === undefined) {
                next();
                return;
            }

            missingFeatureDeps =
                featureDeps.filter(function checkSapiFlagDep(featureDepName) {
                    var depSapiFlagName =
                        FEATURE_NAME_TO_SAPI_FLAG[featureDepName];

                    return sdcApp.metadata[depSapiFlagName] !== true;
                });

            if (missingFeatureDeps.length > 0) {
                err = new Error('Missing NFS volumes feature deps: ' +
                    missingFeatureDeps.join(', '));
            }

            next(err);
        },

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

            getImagesVersions(imgDepsNames, {
                sdcadm: self.sdcadm
            }, function onGotImagesVersions(getImgVersErr, imagesVersions) {
                var outdatedVersionsErr;
                var outdatedVersions = [];

                if (getImgVersErr) {
                    next(getImgVersErr);
                    return;
                }

                assert.arrayOfObject(imagesVersions, 'imagesVersions');

                self.progress('Checking dependencies are up to date');

                imagesVersions.forEach(function checkOutdated(versionInfo) {
                    assert.object(versionInfo, 'versionInfo');

                    var requiredVersionInfo;
                    var serviceName = versionInfo.serviceName;
                    var versionBranch;
                    var versionCommit;
                    var versionComponents;
                    var versionTimestamp;
                    var vmUuid = versionInfo.vmUuid;

                    assert.string(serviceName, 'serviceName');
                    requiredVersionInfo = imageDeps[serviceName];

                    assert.object(requiredVersionInfo,
                        'requiredVersionInfo');
                    assert.string(requiredVersionInfo.branch,
                            'requiredVersionInfo.branch');
                    assert.string(requiredVersionInfo.timestamp,
                        'requiredVersionInfo.timestamp');
                    assert.string(requiredVersionInfo.commit,
                        'requiredVersionInfo.commit');

                    assert.string(versionInfo.version,
                            'versionInfo.version');

                    versionComponents = versionInfo.version.split('-');
                    assert.equal(versionComponents.length, 3,
                            'versionComponents.length');

                    versionBranch = versionComponents[0];
                    versionTimestamp = versionComponents[1];
                    versionCommit = versionComponents[2];

                    assert.string(vmUuid, 'vmUuid');

                    if (!versionSeemsGreaterOrEqualThan({
                        branch: versionBranch,
                        timestamp: versionTimestamp,
                        commit: versionCommit
                    }, requiredVersionInfo)) {
                        outdatedVersions.push('VM ' + versionInfo.vmUuid +
                            ' for service ' + versionInfo.serviceName +
                            ' at version ' + versionInfo.version + ' is ' +
                            'outdated. Minimum required version is ' +
                            versionInfoToString(requiredVersionInfo));
                    }
                });

                if (outdatedVersions && outdatedVersions.length > 0) {
                    outdatedVersionsErr =
                        new Error('Found outdated core services: ' +
                            outdatedVersions.join(', '));
                }

                next(outdatedVersionsErr);
            });
        },

        function checkPlatformDep(ctx, next) {
            var cnapi = self.sdcadm.cnapi;

            if (opts.force === true) {
                next();
                return;
            }

            if (opts.disable === true) {
                next();
                return;
            }

            self.progress('Checking platform version dependencies');

            if (platformVersionDep === undefined) {
                self.progress('Enabling ' + featureName +
                    ' has no platform dependency');
                next();
                return;
            }

            self.progress('Getting servers list');
            cnapi.listServers(function onlistServers(listServersErr, servers) {
                var outdatedServers;

                if (listServersErr) {
                    next(listServersErr);
                    return;
                }

                outdatedServers =
                    servers.filter(function filterOutdated(server) {
                        return server.boot_platform < platformVersionDep;
                    });

                if (outdatedServers.length > 0) {
                    next(new Error('Found outdated servers: ' +
                        outdatedServers.map(renderServerInfo +
                        '. Minimum required platform is: ' +
                        platformVersionDep)));
                    return;
                }

                self.progress('All servers match platform version ' +
                    'requirements');
                next();

                function renderServerInfo(server) {
                    return 'uuid ' + server.uuid + ' boot platform version ' +
                        server.boot_platform;
                }
            });
        },

        function updateSapiFlag(ctx, next) {
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
        help: 'Disable a given NFS volume feature instead of enabling it'
    }
];

do_nfs_volumes.help = (
    'Enables/disables support for various NFS volumes features.\n' +
    '\n' +
    'Usage:\n' +
    '     # Enable NFS volume support for sdc-docker\n' +
    '     {{name}} nfs-volumes docker\n' +
    '     # Disable NFS volume support for sdc-docker\n' +
    '     {{name}} nfs-volumes docker -d\n' +
    '     # Enable NFS volume support for CloudAPI\n' +
    '     {{name}} nfs-volumes cloudapi\n' +
    '     # Disable NFS volume support for CloudAPI\n' +
    '     {{name}} nfs-volumes cloudapi -d\n' +
    '     # Enable docker containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes docker-automount\n' +
    '     # Disable docker containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes docker-automount -d\n' +
    '     # Enable CloudAPI containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes cloudapi-automount\n' +
    '     # Disable CloudAPI containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes cloudapi-automount -d\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_nfs_volumes: do_nfs_volumes
};
