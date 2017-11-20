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

function versionSeemsGreaterOrEqualThan(actualVersion, candidateVersions) {
    var candidateVersion;
    var idx;

    assert.object(actualVersion, 'actualVersion');
    assert.string(actualVersion.branch, 'actualVersion.branch');
    assert.string(actualVersion.timestamp, 'actualVersion.timestamp');
    assert.string(actualVersion.commit, 'actualVersion.commit');
    assert.arrayOfObject(candidateVersions, 'candidateVersions');

    for (idx = 0; idx < candidateVersions.length; ++idx) {
        candidateVersion = candidateVersions[idx];
        assert.object(candidateVersion, 'candidateVersion');
        assert.regexp(candidateVersion.branch, 'candidateVersion.branch');
        assert.string(candidateVersion.timestamp, 'candidateVersion.timestamp');
        assert.string(candidateVersion.commit, 'candidateVersion.commit');

        if (candidateVersion.branch.test(actualVersion.branch) &&
            (candidateVersion.timestamp < actualVersion.timestamp ||
            (candidateVersion.timestamp === actualVersion.timestamp &&
                candidateVersion.commit === actualVersion.commit))) {
            return true;
        }
    }

    return false;
}

function versionsInfoToString(versionsInfo) {
    assert.arrayOfObject(versionsInfo, 'versionsInfo');

    return versionsInfo.map(function renderVersion(versionInfo) {
        assert.object(versionInfo, 'versionInfo');
        assert.regexp(versionInfo.branch, 'versionInfo.branch');
        assert.string(versionInfo.timestamp, 'versionInfo.timestamp');
        assert.string(versionInfo.commit, 'versionInfo.commit');

        return [
            versionInfo.branch.toString(),
            versionInfo.timestamp,
            'g' + versionInfo.commit
        ].join('-');
    }).join(' or ');
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
            cnapi: [
                {
                    branch: /^master$/,
                    timestamp: '20171010T220701Z',
                    commit: '6e83bc4'
                },
                {
                    branch: /^release-\d{8}$/,
                    timestamp: '20171012T160959Z',
                    commit: '6e83bc4'
                }
            ],
            vmapi: [
                {
                    branch: /^master$/,
                    timestamp: '20171110T184239Z',
                    commit: 'a60a380'
                }
            ],
            volapi: [
                {
                    branch: /^master$/,
                    timestamp: '20171107T034233Z',
                    commit: '51006d1'
                },
                {
                    branch: /^release-\d{8}$/,
                    timestamp: '20171109T014437Z',
                    commit: '51006d1'
                }
            ],
            workflow: [
                {
                    branch: /^master$/,
                    timestamp: '20171104T214713Z',
                    commit: 'd02606a'
                },
                {
                    branch: /^release-\d{8}$/,
                    timestamp: '20171109T015544Z',
                    commit: 'd02606a'
                }
            ]
        };

        if (featureName === 'docker') {
            imageDeps.docker = [
                {
                    branch: /^master$/,
                    timestamp: '20171110T202313Z',
                    commit: '9d39e1b'
                }
            ];
        } else {
            imageDeps.cloudapi = [
                {
                    branch: /^master$/,
                    timestamp: '20171110T191649Z',
                    commit: '788a08f'
                }
            ];
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
        function checkFabricsEnabled(ctx, next) {
            var err;

            assert.object(self.sdcadm.sdc.metadata, 'self.sdcadm.sdc.metadata');

            /*
             * Disabling any NFS volumes feature flag does have any requirement,
             * let alone on support for fabric networks.
             */
            if (opts.disable) {
                next();
                return;
            }

            if (!self.sdcadm.sdc.metadata.fabric_cfg) {
                err = new Error('cannot enable NFS volumes feature: this DC ' +
                    'is not setup for fabric networks');
            }

            next(err);
        },

        function checkFeatureDeps(ctx, next) {
            var err;
            var missingFeatureDeps;
            var sdcApp = self.sdcadm.sdc;

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
                    /*
                     * We consider an image version string to have the following
                     * format:
                     *
                     * $branchname-$timestamp-g$commitsha
                     *
                     * where $branchname is composed of alphanumeric characters
                     * and hyphens, $timestamp is a ISO 8601 timestamp and
                     * $commitsha is an alphanumeric lower-case string.
                     */
                    var IMG_VERSION_RE =
                        /^([A-Za-z0-9\-]+)-(\d{8}T\d{6}Z)-g([a-z0-9]+)$/;

                    assert.object(versionInfo, 'versionInfo');

                    var requiredVersionsInfo;
                    var serviceName = versionInfo.serviceName;
                    var versionBranch;
                    var versionCommit;
                    var versionComponents;
                    var versionTimestamp;
                    var vmUuid = versionInfo.vmUuid;

                    assert.string(serviceName, 'serviceName');
                    requiredVersionsInfo = imageDeps[serviceName];

                    assert.arrayOfObject(requiredVersionsInfo,
                        'requiredVersionsInfo');
                    assert.string(versionInfo.version,
                            'versionInfo.version');

                    versionComponents =
                        versionInfo.version.match(IMG_VERSION_RE);
                    assert.ok(versionComponents, 'versionComponents');

                    versionBranch = versionComponents[1];
                    versionTimestamp = versionComponents[2];
                    versionCommit = versionComponents[3];

                    assert.string(vmUuid, 'vmUuid');

                    if (!versionSeemsGreaterOrEqualThan({
                        branch: versionBranch,
                        timestamp: versionTimestamp,
                        commit: versionCommit
                    }, requiredVersionsInfo)) {
                        outdatedVersions.push('VM ' + versionInfo.vmUuid +
                            ' for service ' + versionInfo.serviceName +
                            ' at version ' + versionInfo.version + ' is ' +
                            'outdated. Minimum required versions are: ' +
                            versionsInfoToString(requiredVersionsInfo));
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
            cnapi.listServers({
                reserved: false,
                setup: true
            }, function onlistServers(listServersErr, servers) {
                var nbOutdatedServers;
                var nbServers;
                var outdatedServers;

                if (listServersErr) {
                    next(listServersErr);
                    return;
                }

                if (servers) {
                    nbServers = servers.length;
                    outdatedServers =
                        servers.filter(function filterOutdated(server) {
                            return server.boot_platform < platformVersionDep;
                        });
                    nbOutdatedServers = outdatedServers.length;
                } else {
                    nbServers = 0;
                    nbOutdatedServers = 0;
                }

                if (nbOutdatedServers > 0) {
                    self.progress('Found %d outdated servers: ' +
                        outdatedServers.map(renderServerInfo) +
                        '. Minimum required platform is: ' +
                        platformVersionDep, nbOutdatedServers);
                }

                if (nbServers === 0 || nbServers - nbOutdatedServers === 0) {
                    self.progress('No server matches platform requirements, ' +
                        'feature flag is enabled but functionality will not' +
                        'be available');
                } else if (outdatedServers > 0) {
                    self.progress('Some servers do not match platform ' +
                        'requirements, feature flag is enabled but capacity ' +
                        'might fill up quickly');
                }

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
    '     {{name}} nfs-volumes docker\n\n' +
    '     # Disable NFS volume support for sdc-docker\n' +
    '     {{name}} nfs-volumes docker -d\n\n' +
    '     # Enable NFS volume support for CloudAPI\n' +
    '     {{name}} nfs-volumes cloudapi\n\n' +
    '     # Disable NFS volume support for CloudAPI\n' +
    '     {{name}} nfs-volumes cloudapi -d\n\n' +
    '     # Enable docker containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes docker-automount\n\n' +
    '     # Disable docker containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes docker-automount -d\n\n' +
    '     # Enable CloudAPI containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes cloudapi-automount\n\n' +
    '     # Disable CloudAPI containers automatically mounting NFS volumes\n' +
    '     {{name}} nfs-volumes cloudapi-automount -d\n\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_nfs_volumes: do_nfs_volumes
};
