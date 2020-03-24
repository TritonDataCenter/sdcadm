/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Collection of 'sdcadm platform ...' CLI commands.
 *
 * With the main goal of providing a set of useful tools to operate with
 * HN/CN platforms, the usb key, CNAPI and, in general, all the resources
 * involved into platform management for SDC.
 */

var p = console.log;
var util = require('util');
var format = util.format;
var fs = require('fs');
var cp = require('child_process');
var spawn = cp.spawn;
var tabula = require('tabula');

var vasync = require('vasync');
var assert = require('assert-plus');
var cmdln = require('cmdln');
var Cmdln = cmdln.Cmdln;


var common = require('./common');
var errors = require('./errors');

// --- globals
var MIN_CNAPI_VERSION_NO_LATEST = '20150818';

// --- Platform class
// Intended to be used either from the PlatformCLI class, or from whatever
// else using sdcadm, not necessarily a cmdln tool.

function Platform(top) {
    this.top = top;
    this.sdcadm = top.sdcadm;
    this.progress = top.progress;
    this.log = top.log;
    // Used to keep cache between list and other methods
    this._rawPlatforms = {};
    this._rawServers = [];
    this._usingLatest = [];
}

Platform.prototype.listUSBKeyPlatforms = function listUSBKeyPlatforms(cb) {
    var self = this;
    var usbKeyPlatforms;
    var keyInitiallyMounted;
    vasync.pipeline({funcs: [
        function isKeyMounted(_, next) {
            common.isUsbKeyMounted(self.log, function (err, mounted) {
                if (err) {
                    next(err);
                    return;
                }
                keyInitiallyMounted = mounted;
                next();
            });
        },
        function mountUsbKey(_, next) {
            if (keyInitiallyMounted) {
                next();
                return;
            }
            common.mountUsbKey(self.log, next);
        },
        function getPlatformList(_, next) {
            var argv = [ 'ls', '/mnt/usbkey/os' ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    next(err);
                    return;
                }
                var ary = stdout.trim().split('\n');
                usbKeyPlatforms = ary.sort(function (a, b) {
                    return a.localeCompare(b);
                }).filter(function (i) {
                    return (i !== 'latest');
                }).map(function (i) {
                    return (i.toUpperCase());
                });

                next();
            });
        },
        function unmountUsbKey(_, next) {
            // Do not try to unmount the key if it was already mounted by
            // something else when our process started
            if (keyInitiallyMounted) {
                next();
                return;
            }
            common.unmountUsbKey(self.log, next);
        }

    ]}, function _pipelineCb(err) {
        cb(err, usbKeyPlatforms);
    });
};


Platform.prototype.getPlatformsWithServers =
function getPlatformsWithServers(cb) {
    var self = this;
    var latest;

    self.sdcadm.cnapi.listPlatforms({
        os: true
    }, function (err, platforms) {
        if (err) {
            cb(new errors.SDCClientError(err, 'cnapi'));
            return;
        }
        if (Array.isArray(platforms) && !platforms.length) {
            cb(new errors.UpdateError('no platforms found'));
            return;
        }

        self._rawPlatforms = platforms;
        self.sdcadm.cnapi.listServers({
            setup: true
        }, function (er2, servers) {
            if (er2) {
                cb(new errors.SDCClientError(er2, 'cnapi'));
                return;
            }
            if (Array.isArray(servers) && !servers.length) {
                cb(new errors.UpdateError('no servers found'));
                return;
            }

            self._rawServers = servers;

            Object.keys(platforms).forEach(function (k) {
                platforms[k].boot_platform = [];
                platforms[k].current_platform = [];
                if (platforms[k].latest) {
                    latest = k;
                }
            });

            vasync.forEachParallel({
                inputs: servers,
                func: function (s, next) {
                    if (s.boot_platform === 'latest') {
                        s.boot_platform = latest;
                        self._usingLatest.push(s.uuid);
                    }

                    if (s.current_platform === 'latest') {
                        s.current_platform = latest;
                        self._usingLatest.push(s.uuid);
                    }

                    if (platforms[s.boot_platform]) {
                        platforms[s.boot_platform].boot_platform.push({
                            uuid: s.uuid,
                            hostname: s.hostname
                        });
                    }

                    if (platforms[s.current_platform]) {
                        platforms[s.current_platform].current_platform
                            .push({
                            uuid: s.uuid,
                            hostname: s.hostname
                        });
                    }

                    next();
                }
            }, function (er3, results) {
                if (er3) {
                    cb(new errors.InternalError({
                        message: 'Error fetching platforms servers'
                    }));
                    return;
                }
                cb(null, platforms);
            });
        });
    });
};


// Get version for latest platform image installed into usbkey cache.
// cb(err, latest)
Platform.prototype.getLatestPlatformInstalled =
function getLatestPlatformInstalled(os, cb) {
    if (typeof (os) === 'function') {
        cb = os;
        os = 'smartos';
    }
    const self = this;
    self.sdcadm.cnapi.listPlatforms({
        os: true
    }, function (err, platforms) {
        if (err) {
            cb(err);
            return;
        }
        const latest = Object.keys(platforms).filter(function isLatest(pi) {
            const isLatestP = typeof (platforms[pi].latest) !== 'undefined';
            if (platforms[pi].os) {
                return (platforms[pi].os === os && isLatestP);
            } else {
                return (isLatestP);
            }
        }).pop();
        cb(null, latest);
    });
};

// TODO: svcprop -p 'joyentfs/usb_copy_path' \
//          svc:/system/filesystem/smartdc:default
Platform.prototype.createLatestLink =
function createLatestLink(cb) {
    var self = this;

    self.getCNAPIVersion(function (err, version) {
        if (err) {
            cb(err);
            return;
        }
        // Do nothing if we've already deprecated latest in CNAPI
        if (version >= MIN_CNAPI_VERSION_NO_LATEST) {
            cb();
            return;
        }

        self.progress('Updating \'latest\' link');
        var argv = [ 'rm', '-f', '/usbkey/os/latest' ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err1, stdout1, stderr1) {
            if (err1) {
                cb(err1);
                return;
            }
            self.getLatestPlatformInstalled(function (err2, latest) {
                if (err2) {
                    cb(err2);
                    return;
                }
                argv = ['ln', '-s', latest, 'latest'];
                common.execFilePlus({
                    argv: argv,
                    cwd: '/usbkey/os',
                    log: self.log
                }, function (err3, stdout3, stderr3) {
                    if (err3) {
                        cb(err3);
                        return;
                    }
                    cb();
                });
            });
        });
    });
};

/*
 * Return the list of remotely available platform images published after
 * the latest image installed locally.
 */
Platform.prototype.available = function available(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.channel, 'opts.channel');
    assert.optionalString(opts.os, 'opts.os');

    const self = this;

    const context = {
        imgs: []
    };
    vasync.pipeline({arg: context, funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function getLatestInstalled(ctx, next) {
            // Set or override the default channel if anything is given:
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }
            self.getLatestPlatformInstalled(function (err2, latest) {
                if (err2) {
                    next(err2);
                    return;
                }
                ctx.latest = latest;
                next();
            });
        },
        function getLatestLinuxInstalled(ctx, next) {
            self.getLatestPlatformInstalled('linux', function (err2, latest) {
                if (err2) {
                    next(err2);
                    return;
                }
                ctx.latestLinux = latest;
                next();
            });
        },
        function getAvailableImages(ctx, next) {
            const filter = {
                name: (opts.os === 'smartos') ? 'platform' :
                        opts.os === 'linux' ? 'platform-linux' : '~platform'
            };
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(new errors.SDCClientError(err, 'updates'));
                    return;
                }
                if (Array.isArray(images) && !images.length) {
                    next(new errors.UpdateError('no images found'));
                    return;
                }
                common.sortArrayOfObjects(images, ['published_at']);
                images = images.map(function (img) {
                    return ({
                        version: img.version.split('-').pop(),
                        uuid: img.uuid,
                        published_at: img.published_at,
                        os: img.os === 'other' ? 'smartos' : img.os
                    });
                }).filter(function (i) {
                    if (i.os === 'smartos') {
                        return (i.version > ctx.latest);
                    } else {
                        return (i.version > ctx.latestLinux);
                    }
                });
                ctx.imgs = images;
                next(null);
            });
        }
    ]}, function pipeCb(pipeErr) {
        cb(pipeErr, context.imgs);
    });
};


Platform.prototype.list = function list(cb) {
    var self = this;
    self.getDefaultBootPlatform(function (err, defPlatform) {
        if (err) {
            cb(err);
            return;
        }
        self.getPlatformsWithServers(function (err1, platforms) {
            if (err1) {
                cb(err1);
                return;
            }

            self.listUSBKeyPlatforms(function (er2, usbKeyPlatforms) {
                if (er2) {
                    cb(er2);
                    return;
                }

                platforms = Object.keys(platforms).map(function (k) {
                    return {
                        version: k,
                        boot_platform: platforms[k].boot_platform,
                        current_platform: platforms[k].current_platform,
                        latest: platforms[k].latest || false,
                        default: (k === defPlatform),
                        usb_key: (usbKeyPlatforms.indexOf(k) !== -1),
                        os: platforms[k].os === 'other' ?
                            'smartos' : platforms[k].os
                    };
                });

                cb(null, platforms);
            });
        });
    });
};


/**
 * Fetch a given platform image (or if desired, latest), download it,
 * then use /usbkey/scripts/install-platform.sh to add to list of available
 * platforms from which to boot compute nodes
 */
Platform.prototype.install = function install(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.image, 'opts.image');
    assert.optionalString(opts.channel, 'opts.channel');
    assert.optionalString(opts.os, 'opts.os');

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var defaultChannel;
    var filepath;
    var image;
    var progress = self.progress;
    var latest;
    // TOOLS-876: Keep track of when an error happened during downloads, in
    // order to avoid suggesting the user to re-run a bogus file
    var downloadError = false;
    // TOOLS-1206: Keep track of when an error happened trying to find an
    // image in order to avoid same thing than for TOOLS-876
    var imgNotFoundError = false;
    const opSystem = opts.os || 'smartos';

    // platform, platform-linux, ~platform for both
    function findPlatformImageLatest(os, cb) {
        if (typeof (os) === 'function') {
            cb = os;
            os = 'smartos';
        }

        const filter = {
            name: os === 'smartos' ? 'platform' : 'platform-linux'
        };

        self.sdcadm.updates.listImages(filter, function (err, images) {
            if (err) {
                imgNotFoundError = true;
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                imgNotFoundError = true;
                cb(new errors.UpdateError('no images found'));
                return;
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];

            cb();
        });
    }


    function findPlatformImageByUuid(cb) {
        self.sdcadm.updates.getImage(opts.image, function (err, foundImage) {
            if (err) {
                imgNotFoundError = true;
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            cb();
        });
    }

    function findPlatformBySearching(os, cb) {
        if (typeof (os) === 'function') {
            cb = os;
            os = 'smartos';
        }
        var filter = {
            name: os === 'smartos' ? 'platform' : 'platform-linux',
            version: '~' + '-' + opts.image
        };
        self.sdcadm.updates.listImages(filter, function (err, images) {
            if (err) {
                imgNotFoundError = true;
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                imgNotFoundError = true;
                cb(new errors.UpdateError('no images found'));
                return;
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];
            cb();
        });
        return;
    }

    function downloadPlatformImage(cb) {
        var realVersion = image.version.split('-').pop();
        progress('Downloading platform %s', realVersion);
        progress(common.indent(format('image %s', image.uuid)));
        progress(common.indent(format('to %s', filepath)));

        function onImage(err) {
            if (err) {
                downloadError = true;
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            cb();
        }
        self.sdcadm.updates.getImageFile(image.uuid, filepath, onImage);
    }

    function executeInstallerFile(cb) {
        progress('Installing Platform Image onto USB key');
        var INSTALL_PLATFORM = '/usbkey/scripts/install-platform.sh';
        var child = spawn(
            INSTALL_PLATFORM, [ filepath ],
            { stdio: 'inherit' });

        child.on('exit', function (code) {
            // This is the expected exit code for errors handled by
            // install-platform.sh script:
            if (code) {
                progress(format(
                    'install-platform.sh script failed for platform %s.',
                    filepath));
                progress('Please, check /tmp/install_platform.log for ' +
                    'additional information.');
                cb(new Error('Platform setup failed'));
                return;
            }
            progress('Platform installer finished successfully');
            progress('Proceeding to complete the update');
            cb();
        });
    }

    function cleanup(cb) {
        fs.unlink(filepath, function (err) {
            if (err) {
                self.log.warn(err, 'unlinking %s', filepath);
            }
            progress('Installation complete');
            cb();
        });
    }

    vasync.pipeline({arg: {}, funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function getChannel(_, next) {
            // Set or override the default channel if anything is given:
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }
            self.sdcadm.getDefaultChannel(function (err, channel) {
                // Will not fail the whole operation due to channel not found
                if (err) {
                    next();
                    return;
                }
                defaultChannel = channel;
                if (!fs.existsSync(opts.image)) {
                    progress('Using channel %s', channel);
                }
                next();
            });
        },
        function findLatest(_, next) {
            self.getLatestPlatformInstalled(opSystem, function (err, platf) {
                if (err) {
                    next(err);
                    return;
                }
                latest = platf;
                next();
            });
        },
        // Make sure that if we install a new platform and Headnode is using
        // "latest", we really know what we're doing:
        function checkHeadnodePlatform(_, next) {
            if (opts.yes || opSystem !== 'smartos') {
                next();
                return;
            }
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, res) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }
                var hn_uuid = res[0].uuid;
                self.sdcadm.cnapi.getBootParams(hn_uuid, function (er2, boot) {
                    if (er2) {
                        next(new errors.SDCClientError(er2, 'cnapi'));
                        return;
                    }
                    if (boot.platform === 'latest') {
                        progress('');
                        progress('Headnode configuration is using a symlink' +
                            ' to latest Platform Image. Please run\n\n' +
                            'sdcadm platform assign %s %s\n\nbefore to ' +
                            'continue, in order to prevent further issues.',
                            latest, hn_uuid);
                        progress('');

                        progress('Aborting platform install');
                        callback();
                        return;
                    }
                    next();
                });
            });
        },
        function findPlatformImage(_, next) {
            // Check if the value of the parameter `image` is a file
            if (fs.existsSync(opts.image)) {
                filepath = opts.image;
                deleteOnFinish = false;
                /* eslint-disable callback-return */
                next();
                /* eslint-enable callback-return */
            } else if (opts.image === 'latest') {
                findPlatformImageLatest(opSystem, next);
            } else if (opts.image.match(
                /([a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}?)/ig)) {
                findPlatformImageByUuid(next);
            } else {
                findPlatformBySearching(opSystem, next);
            }
        },

        function verifyLatesltIsNotAlreadyInstalled(_, next) {
            if (opts.image !== 'latest') {
                next();
                return;
            }
            progress('Checking latest Platform Image is already installed');
            var realVersion = image.version.split('-').pop();
            if (realVersion === latest) {
                progress('Latest Platform Image already installed');
                callback(null);
                return;
            }
            next();
        },

        function downloadImage(_, next) {
            if (filepath) {
                /* eslint-disable callback-return */
                progress(format('Using platform file %s', filepath));
                next();
                /* eslint-enable callback-return */
            } else {
                filepath = format('%s/platform-%s.tgz',
                                  localdir, image.version);
                downloadPlatformImage(next);
            }
        },
        // TOOLS-1387: Check PI size vs available disk space before we try
        // to run the installer in order to fail early when possible.
        function checkPIUncompressedSize(ctx, next) {
            if (opSystem !== 'smartos') {
                next();
                return;
            }
            common.execFilePlus({
                argv: ['/usr/bin/gzip', '-lq', filepath],
                log: self.log
            }, function gzipCb(err, stdout) {
                if (err) {
                    next(err);
                    return;
                }
                stdout = stdout.trim().split('\n');
                stdout = stdout[0].split(/\s+/);
                var uncompressed = parseInt(stdout[1], 10);
                if (!uncompressed) {
                    next(new Error('Unexpected gzip output'));
                    return;
                }
                ctx.platformImageSize = (uncompressed / 1024);
                next();
            });
        },
        function mountUsbKey(_, next) {
            if (opSystem !== 'smartos') {
                next();
                return;
            }
            common.mountUsbKey(self.log, next);
        },
        function checkAvailableDiskSpace(ctx, next) {
            if (opSystem !== 'smartos') {
                next();
                return;
            }
            common.execFilePlus({
                argv: ['/usr/bin/df', '-k', '/mnt/usbkey/os'],
                log: self.log
            }, function dfCb(err, stdout) {
                if (err) {
                    next(err);
                    return;
                }
                stdout = stdout.trim().split('\n');
                stdout = stdout[1].split(/\s+/);
                var avail = parseInt(stdout[3], 10);
                if (!avail) {
                    next(new Error('Unexpected df output'));
                    return;
                }
                if (avail < ctx.platformImageSize) {
                    self.progress('Available disk space in USB key is %d ' +
                            'MiB', (avail / 1024).toFixed(0));
                    self.progress('Required disk space for PI setup is %d ' +
                            'MiB', (ctx.platformImageSize / 1024).toFixed(0));
                    next(new Error('Not enough disk space available'));
                    return;
                }
                next();
            });
        },
        function execInstaller(_, next) {
            executeInstallerFile(next);
        },
        function linkLatest(_, next) {
            if (opSystem !== 'smartos') {
                next();
                return;
            }
            self.createLatestLink(next);
        },
        function updateBootParams(_, next) {
            if (opSystem !== 'smartos') {
                next();
                return;
            }
            self.setDefaultBootPlatform(next);
        }
    ]}, function pipelineCb(err) {
        if (err) {
            progress('Error: %s', err.message);
            if (downloadError) {
                progress('Please re-run `sdcadm platform install` with ' +
                        'the same options in order to attempt to ' +
                        'successfully download the image.');
            } else if (imgNotFoundError) {
                progress('Unable to find the given Platform Image \'%s\' ' +
                        'in channel \'%s\'', opts.image,
                        self.sdcadm.updates.channel || defaultChannel);
            } else {
                if (filepath) {
                    progress('In order not to have to re-download image, ' +
                             '%s has been left behind.', filepath);
                    progress('After correcting above problem, rerun ' +
                             '`sdcadm platform install %s`.', filepath);
                }
            }
            callback(err);
            return;
        }

        if (deleteOnFinish) {
            cleanup(callback);
            return;
        } else {
            progress('Platform image explicitly specified; ' +
                     'will not delete %s', filepath);
            progress('Installation complete');
        }

        callback();
        return;
    });
};

Platform.prototype.setDefaultBootPlatform =
function setDefaultBootPlatform(version, cb) {
    var self = this;
    var bootParams;
    var latestPlatform;
    if (typeof (version) === 'function') {
        cb = version;
        version = 'latest';
    }

    vasync.pipeline({funcs: [
        function getBootParams(_, next) {
            self.sdcadm.cnapi.getBootParams('default', function (err, params) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }
                bootParams = params;
                next();
                return;
            });
        },
        function getPlatformsList(_, next) {
            if (self._rawPlatforms.length) {
                next();
                return;
            }
            self.sdcadm.cnapi.listPlatforms({
                os: true
            }, function (err, platforms) {
                if (err) {
                    next(err);
                    return;
                }

                self._rawPlatforms = platforms;
                next();
            });
        },
        function verifyPlatformExists(_, next) {
            if (version === 'latest') {
                next();
                return;
            }

            if (Object.keys(self._rawPlatforms).indexOf(version) === -1) {
                next(new errors.UsageError(
                    'Invalid platform version: ' + version));
                return;
            }
            next();
        },
        function verifyPlaformIsSmartOS(_, next) {
            if (version === 'latest') {
                next();
                return;
            }
            if (self._rawPlatforms[version].os &&
                self._rawPlatforms[version].os !== 'smartos') {
                next(new errors.UsageError(
                    'Only SmartOS Platform Images can be set as default'));
                return;
            }
            next();
        },
        function getLatestPlatformVersion(_, next) {
            if (version !== 'latest') {
                next();
                return;
            }
            Object.keys(self._rawPlatforms).forEach(function (pl) {
                if (self._rawPlatforms[pl].latest) {
                    // First case: Old CNAPI, no `platform.os` value:
                    if (!self._rawPlatforms[pl].os ||
                        // Second case: New CNAPI, only "smartos" can be
                        // used for default Platform Image
                        self._rawPlatforms[pl].os === 'smartos') {
                        latestPlatform = pl;
                    }
                }
            });
            next();
        },

        function setDefaultBootParams(_, next) {
            if (version === 'latest' && bootParams.platform !== 'latest') {
                next();
                return;
            }
            self.progress(
                'Updating default boot platform to \'%s\'',
                (latestPlatform ? latestPlatform : version));
            self.sdcadm.cnapi.setBootParams('default', {
                platform: (latestPlatform ? latestPlatform : version)
            }, function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }
                next();
            });
        }
    ]}, cb);
};

Platform.prototype.getDefaultBootPlatform =
function getDefaultBootPlatform(cb) {
    var self = this;
    self.sdcadm.cnapi.getBootParams('default', function (err, bootParams) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'cnapi'));
        }
        return cb(null, bootParams.platform);
    });
};

// CNAPI-518/TOOLS-988: Stop relying into "latest" as platform image version.
//
// Utility method to be called from platform assign. Added as a separate
// method in order to make easier the removal of this whole part of the code
// in the future. The following tasks will be performed by this method when
// required:
//
// - Fetch CNAPI version and verify we're past "latest" dependency
// - Update default boot params to use the latest platform image instead of
// "latest" symlink
// - Update any CNs using "latest" symlink
Platform.prototype.deprecateLatest = function deprecateLatest(callback) {
    var self = this;
    var isVersionOk = false;
    var bootParams;
    var latestPlatform;
    vasync.pipeline({funcs: [
        function checkMinCNAPIVersion(_, next) {
            self.getCNAPIVersion(function (err, version) {
                if (err) {
                    next(err);
                    return;
                }
                isVersionOk = (version >= MIN_CNAPI_VERSION_NO_LATEST);
                next();
            });
        },
        function getBootParams(_, next) {
            if (!isVersionOk) {
                next();
                return;
            }
            self.sdcadm.cnapi.getBootParams('default', function (err, params) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }
                bootParams = params;
                next();
            });
        },
        function getLatestPlatformVersion(_, next) {
            if (!isVersionOk) {
                next();
                return;
            }
            if (!self._usingLatest.length &&
                    (bootParams.platform !== 'latest')) {
                next();
                return;
            }
            Object.keys(self._rawPlatforms).forEach(function (pl) {
                if (self._rawPlatforms[pl].latest) {
                    latestPlatform = pl;
                }
            });
            next();
        },
        function setDefBootParams(_, next) {
            if (!isVersionOk || bootParams.platform !== 'latest') {
                next();
                return;
            }
            self.progress(
                'Updating default boot platform from \'latest\' to \'%s\'',
                latestPlatform);
            self.sdcadm.cnapi.setBootParams('default', {
                platform: latestPlatform
            }, function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }
                next();
            });
        },
        function updateCNs(_, next) {
            if (!isVersionOk || !self._usingLatest.length) {
                next();
                return;
            }
            self.progress('Updating boot platform  from \'latest\' to' +
                    '\'%s\' for CNs %s', latestPlatform,
                    self._usingLatest.join(','));
            // We need to empty self._usingLatest to prevent an infinite loop:
            var cns = self._usingLatest.slice();
            self._usingLatest = [];

            self.assign({
                platform: latestPlatform,
                server: cns
            }, next);
        },
        function removeLatestSymlink(_, next) {
            var argv = [ 'rm', '-f', '/usbkey/os/latest' ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    next(err);
                    return;
                }
                self.progress('Cleaned up deprecated \'latest\' symlink');
                next();
            });
         }
    ]}, callback);
};

/**
 * Returns the relevant 8 digits of the CNAPI image version for the first
 * found CNAPI instance. (YYYYMMDD)
 */
Platform.prototype.getCNAPIVersion = function getCNAPIVersion(callback) {
    var self = this;
    var img, version;
    vasync.pipeline({funcs: [
        function getCnapiVmsImgs(_, next) {
            self.sdcadm.getImgsForSvcVms({
                svc: 'cnapi'
            }, function (err, obj) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                img = obj.imgs[0];
                next();
            });
        },

        function getCnapiVersion(_, next) {
            var splitVersion = img.version.split('-');

            if (splitVersion[0] === 'master') {
                version = splitVersion[1].substr(0, 8);
            } else if (splitVersion[0] === 'release') {
                version = splitVersion[1];
            }

            next();
        }
    ]}, function pipeCb(err) {
        callback(err, version);
    });
};


/**
 * Assigns a new platform to a compute node and ensures all necessary
 * post-assign steps are performed.
 */
Platform.prototype.assign = function assign(opts, callback) {
    var self = this;
    assert.object(opts, 'opts');
    assert.optionalBool(opts.all, 'opts.all');
    assert.string(opts.platform, 'opts.platform');
    assert.optionalArrayOfString(opts.server, 'opts.server');

    if (!opts.all && !opts.server) {
        callback(new Error('must specify a SERVER or --all'));
        return;
    }

    var serverRecs = [];
    var assignServers = [];
    var uuids = [];
    var adminTags = [];
    var headnode;
    var progress = self.progress;

    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    var errs = [];

    const wantLatest = (opts.platform === 'latest');


    /*
     * The booter(dhcpd) zone maintains a set of bootparams for each admin mac
     * address of each server(CN).  The bootparams specify which platform image
     * is assigned to a given CN.
     *
     * This step updates the bootparams on the dhcpd(booter) zone.  First it
     * gathers all of the admin NICs from both the 'admin' network, and the
     * 'admin' network pool that belong to servers(CNs).  Then it retrieves
     * the associated mac addresses which are then passed as arguments to a
     * command line tool("booter bootparams") on the booter zone.  This tool
     * will update each server's boot params (as stored in the booter zone) to
     * specify the new platform image for each given admin mac address.
     */
    function updateBooterCache(servers, cb) {
        var macs;
        var serveruuids = servers.map(function (server) {
            return server.uuid;
        });

        progress('Updating booter cache for servers');

        vasync.pipeline({funcs: [
            function getAdminNicTags(_, next) {
                self.sdcadm.napi.listNetworkPools({name: 'admin'},
                    function (err, pools) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'napi'));
                        return;
                    }

                    if (pools.length > 1) {
                        progress('Multiple network pools named "admin", '
                            + 'using %s', pools[0].uuid);
                    }

                    /*
                     * The presence of an admin network pool is optional.
                     */
                    if (pools.length === 0) {
                        next();
                        return;
                    }

                    adminTags = pools[0].nic_tags_present;
                    next();
                });
            },
            function getAdminNics(_, next) {
                if (adminTags.indexOf('admin') === -1) {
                    adminTags.push('admin');
                }

                var listOpts = {
                    belongs_to_type: 'server',
                    nic_tags_provided: adminTags
                };
                if (!opts.all) {
                    listOpts.belongs_to_uuid = serveruuids;
                }
                self.sdcadm.napi.listNics(listOpts, {}, function (err, nics) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'napi'));
                        return;
                    }

                    macs = nics.map(function (nic) {
                        return nic.mac;
                    });

                    next();
                });
            },
            function overrideBootParamsInDhcpdZone(_, next) {
                var script = format(
                    '#!/bin/bash\n' +
                    'export PATH=$PATH:/usr/bin:/usr/sbin:/opt/smartdc/bin/\n' +
                    'cat <<EOF> /var/tmp/macs.$$;\n' +
                    macs.join('\n') + '\n' +
                    'EOF\n' +
                    'cat /var/tmp/macs.$$ ' +
                    '    | sdc-login dhcpd "' +
                    '       xargs -n 1 ' +
                    '           /opt/smartdc/booter/bin/booter bootparams"\n' +
                    'rm /var/tmp/macs.$$\n'
                );


                self.sdcadm.cnapi.commandExecute(headnode.uuid, script, {
                }, function (err) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'cnapi'));
                        return;
                    }
                    next();
                });
            }
        ]}, function (err) {
            if (err) {
                cb(err);
                return;
            }
            progress('Done updating booter caches');
            cb();
        });
    }

    function assignForHeadnode(server, cb) {
        vasync.pipeline({funcs: [
            function doSwitchPlatform(_, next) {
                progress(
                    'updating headnode %s to %s',
                    server.uuid, opts.platform);

                var script = format(
                    '#!/bin/bash\n' +
                    'export PATH=$PATH:/usr/bin:/usr/sbin:/opt/smartdc/bin/\n' +
                    '/usbkey/scripts/switch-platform.sh %s;',
                    opts.platform);

                self.sdcadm.cnapi.commandExecute(server.uuid, script, {
                }, next);
            },
            function doSetBootParams(_, next) {
                progress('Setting boot params for %s', server.uuid);
                self.sdcadm.cnapi.setBootParams(server.uuid, {
                    platform: opts.platform
                }, {}, next);
            }
        ]}, function (err) {
            if (err) {
                errs.push(new errors.SDCClientError(err, 'cnapi'));
            }
            cb(err);
        });
    }

    function assignForComputenode(server, cb) {
        const currOS = self._rawPlatforms[server.current_platform] ?
            self._rawPlatforms[server.current_platform].os :
            'smartos';
        var platf;
        if (wantLatest) {
            platf = currOS === 'smartos' ? opts.platform : opts.platformLinux;
        } else {
            const platformOs = self._rawPlatforms[opts.platform] ?
                self._rawPlatforms[opts.platform].os :
                'smartos';
            if (currOS !== platformOs) {
                var usageErr = new errors.UsageError(
                    'Cannot change server Operating System without ' +
                    'a Factory Reset');
                errs.push(usageErr);
                cb(usageErr);
                return;
            }
            platf = opts.platform;
        }
        progress('updating computenode %s to %s', server.uuid, platf);
        progress('Setting cn boot params for %s', server.uuid);
        self.sdcadm.cnapi.setBootParams(server.uuid, {
            platform: platf
        }, {}, function (err) {
            if (err) {
                errs.push(new errors.SDCClientError(err, 'cnapi'));
            }
            cb(err);
        });
    }

    vasync.pipeline({funcs: [
        function findLatest(_, next) {
            if (!wantLatest) {
                next();
                return;
            }
            self.getLatestPlatformInstalled(function (err, latest) {
                if (err) {
                    next(err);
                    return;
                }
                opts.platform = latest;
                next();
            });
        },
        function findLatestLinux(_, next) {
            if (!wantLatest) {
                next();
                return;
            }
            self.getLatestPlatformInstalled('linux', function (err, latest) {
                if (err) {
                    next(err);
                    return;
                }
                opts.platformLinux = latest;
                next();
            });
        },
        function validatePlatform(_, next) {
            self.sdcadm.cnapi.listPlatforms({
                os: true
            }, function (err, platforms) {
                if (err) {
                    next(err);
                    return;
                }

                self._rawPlatforms = platforms;

                if (Object.keys(platforms).indexOf(opts.platform) === -1) {
                    callback(new Error(format(
                            'invalid platform %s', opts.platform)));
                    return;
                }
                next();
            });
        },
        function serverList(_, next) {
            self.sdcadm.cnapi.listServers({
                setup: true
            }, function (err, recs) {
                if (err) {
                    next(err);
                    return;
                }
                serverRecs = recs;
                self._rawServers = serverRecs;

                next();
            });
        },
        function findServersToUpdate(_, next) {
            // Find the headnode and depending on the options passed in,
            // either a single compute node or multiple. We need the headnode
            // details so that we can update the booter cache on the headnode
            // dhcpd zone.
            serverRecs.forEach(function (server) {
                if (server.headnode === true) {
                    headnode = server;
                }

                if (opts.all) {
                    assignServers.push(server);
                } else if (opts.server.indexOf(server.hostname) !== -1 ||
                    opts.server.indexOf(server.uuid) !== -1) {
                    assignServers.push(server);
                } else {
                    if (server.boot_platform === 'latest' ||
                            server.current_platform === 'latest') {
                        self._usingLatest.push(server.uuid);
                    }
                }
            });

            if (opts.server && !assignServers.length) {
                next(new Error(format(
                        'server %j not found', opts.server)));
                return;
            }

            uuids = assignServers.map(function (s) {
                return (s.uuid);
            });

            next();
        },

        function assignPlatform(_, next) {
            function doAssignServerPlatform(server, nextServer) {
                if (server.headnode) {
                    return assignForHeadnode(server, nextServer);
                } else {
                    return assignForComputenode(server, nextServer);
                }
            }

            var assignQueue = vasync.queue(doAssignServerPlatform, 5);
            assignQueue.once('end', next);
            assignQueue.push(assignServers);
            assignQueue.close();
        },
        function doUpdateBooterCache(_, next) {
            updateBooterCache(assignServers, next);
        },
        // TOOLS-945: There has been cases where CNAPI didn't updated all the
        // servers boot_platform w/o reporting any failure at all. We'll just
        // double check and complain if that happens:
        function verifyUpdate(_, next) {
            // Skip this if it failed before:
            if (errs.length) {
                next();
                return;
            }
            progress('Verifying boot_platform updates');
            self.sdcadm.cnapi.listServers({
                uuids: uuids.join(',')
            }, function (err, updated) {
                if (err) {
                    next(err);
                    return;
                }
                var updateErrs = [];
                updated.forEach(function (u) {
                    if (u.boot_platform !== opts.platform &&
                        u.boot_platform !== opts.platformLinux) {
                        updateErrs.push(u.uuid);
                    }
                });
                if (updateErrs.length) {
                    var msg = 'The following servers were not updated: ' +
                        updateErrs.join(',');
                    next(new errors.SDCClientError({
                        message: msg
                    }, 'cnapi'));
                    return;
                }
                next();
            });
        },
        function callDeprecateLatest(_, next) {
            self.deprecateLatest(next);
        },
        function setDefault(_, next) {
            if (!opts.all) {
                next();
                return;
            }
            self.setDefaultBootPlatform(opts.platform, next);
        }
    ]},
    function (err) {
        if (errs.length) {
            err = new errors.MultiError(errs);
        }
        callback(err);
    });
};


Platform.prototype.usage = function (platform, cb) {
    var self = this;
    assert.string(platform, 'platform');

    self.sdcadm.cnapi.listPlatforms({
        os: true
    }, function (err, platforms) {
        if (err) {
            cb(new errors.SDCClientError(err, 'cnapi'));
            return;
        }
        if (Array.isArray(platforms) && !platforms.length) {
            cb(new errors.UpdateError('no platforms found'));
            return;
        }
        if (Object.keys(platforms).indexOf(platform) === -1) {
            cb(new Error(format(
                    'invalid platform %s', platform)));
            return;
        }
        self.sdcadm.cnapi.listServers({
            setup: true
        }, function (er2, servers) {
            if (er2) {
                cb(new errors.SDCClientError(er2, 'cnapi'));
                return;
            }
            if (Array.isArray(servers) && !servers.length) {
                cb(new errors.UpdateError('no servers found'));
                return;
            }

            var rows = [];

            vasync.forEachParallel({
                inputs: servers,
                func: function (s, next) {
                    if (s.boot_platform === platform ||
                        s.current_platform === platform) {
                        rows.push({
                            uuid: s.uuid,
                            hostname: s.hostname,
                            current_platform: s.current_platform,
                            boot_platform: s.boot_platform
                        });
                    }
                    next();
                }
            }, function (er3) {
                if (er3) {
                    cb(er3);
                    return;
                }
                cb(null, rows);
            });
        });
    });
};


Platform.prototype.remove = function remove(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.optionalBool(opts.cleanup_cache, 'opts.cleanup_cache');
    assert.optionalBool(opts.yes, 'opts.yes');
    assert.arrayOfString(opts.remove, 'opts.remove');

    var keyInitiallyMounted;

    vasync.pipeline({funcs: [
        function confirm(_, next) {
            p('');
            p('The following Platform Images will be removed:');
            p(common.indent(opts.remove.join('\n')));
            p('');
            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    cb();
                    return;
                }
                p('');
                next();
            });
        },

        function isKeyMounted(_, next) {
            common.isUsbKeyMounted(self.sdcadm.log, function (err, mounted) {
                if (err) {
                    next(err);
                    return;
                }
                keyInitiallyMounted = mounted;
                next();
            });
        },
        function mountUsbKey(_, next) {
            if (keyInitiallyMounted) {
                next();
                return;
            }
            p('Mounting USB key');
            common.mountUsbKey(self.sdcadm.log, next);
        },

        // TODO: svcprop -p 'joyentfs/usb_mountpoint' \
        //          svc:/system/filesystem/smartdc:default
        function removePlatforms(_, next) {
            vasync.forEachParallel({
                inputs: opts.remove,
                func: function removePlatform(name, next_) {
                    p('Removing platform ' + name);
                    var argv = [
                        'rm', '-rf',
                        '/mnt/usbkey/os/' + name
                    ];
                    common.execFilePlus({
                        argv: argv,
                        log: self.sdcadm.log
                    }, next_);
                }
            }, function (er3) {
                if (er3) {
                    self.sdcadm.log.error(er3);
                }
                next();
            });
        },

        function unmountUsbKey(_, next) {
            if (keyInitiallyMounted) {
                next();
                return;
            }
            p('Unmounting USB key');
            common.unmountUsbKey(self.sdcadm.log, next);
        },

        // TODO: svcprop -p 'joyentfs/usb_copy_path' \
        //          svc:/system/filesystem/smartdc:default
        function removePlatformsCache(_, next) {
            if (!opts.cleanup_cache) {
                next();
                return;
            }

            vasync.forEachParallel({
                inputs: opts.remove,
                func: function removePlatformCache(name, next_) {
                    p('Removing cache for platform ' + name);
                    var argv = [
                        'rm', '-rf',
                        '/usbkey/os/' + name
                    ];
                    common.execFilePlus({
                        argv: argv,
                        log: self.sdcadm.log
                    }, next_);
                }
            }, function (er3) {
                if (er3) {
                    self.sdcadm.log.error(er3);
                }
                return next();
            });
        },

        // TODO: svcprop -p 'joyentfs/usb_copy_path' \
        //          svc:/system/filesystem/smartdc:default
        function doCreateLatestLink(_, next) {
            if (!opts.cleanup_cache) {
                next();
                return;
            }
            p('Updating \'latest\' link');
            self.createLatestLink(next);
        }
    ]}, function (err) {
        var msg = err ? 'Done with errors.' : 'Done.';
        p(msg);
        cb(err);
    });
};

// --- Platform CLI class

function PlatformCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm platform',
        desc: 'Platform related sdcadm commands.\n' +
              '\n' +
              'These are commands to assist with the common set of tasks\n' +
              'required to manage platforms on a typical SDC setup.\n' +
              '\n' +
              'Note that SDC keeps a cache directory (/usbkey/os) of the\n' +
              'Platform Images installed on the USB key (/mnt/usbkey/os).\n' +
              'Please read help of sub-commands in order to know how this\n' +
              'may or not affect each of them.',
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        }
    });
}
util.inherits(PlatformCLI, Cmdln);

PlatformCLI.prototype.init = function init(_opts, _args, _callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;
    this.platform = new Platform(this.top);
    Cmdln.prototype.init.apply(this, arguments);
};

/*
 * Update platform in datancenter with a given or latest platform installer.
 */
PlatformCLI.prototype.do_install =
function do_install(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (!opts.latest && !args[0]) {
        cb(new errors.UsageError(
            'must specify Platform Image UUID or --latest'));
        return;
    }

    if (args[0] && args[0] === 'help') {
        cb(new errors.UsageError(
            'Please use `sdcadm platform help install` instead'));
        return;
    }

    if (opts.os && !opts.latest) {
        cb(new errors.UsageError(
            'Option --os can be used only with --latest'));
        return;
    }

    var options = {
        image: (opts.latest) ? 'latest' : args[0]
    };

    if (opts.channel) {
        options.channel = opts.channel;
    }

    if (opts.yes) {
        options.yes = opts.yes;
    }

    // Given `--latest` and no `--os` means we want to install latest
    // available Platform Image for both, SmartOS & Linux.
    if (opts.latest && !opts.os) {
        p('Installing latest SmartOS Platform Image');
        self.platform.install(Object.assign({
            os: 'smartos'
        }, options), function (err) {
            if (err) {
                cb(err);
                return;
            }
            p('Installing latest Linux Platform Image');
            self.platform.install(Object.assign({
                os: 'linux'
            }, options), cb);
        });
    } else {
        self.platform.install(options, cb);
    }
};

PlatformCLI.prototype.do_install.help = (
    'Download and install Platform Image for later assignment.\n' +
    '\n' +
    'Please note that installing a new Platform Image will not\n' +
    'assign this image to any server. Install will download the\n' +
    'image and put it on the platform cache directory (/usbkey/os).\n' +
    'The image is made available through CNAPI for later assignment.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} install IMAGE-UUID\n' +
    '     {{name}} install PATH-TO-IMAGE\n' +
    '     {{name}} install --latest\n' +
    '     {{name}} install --latest --os=linux\n' +
    '\n' +
    '{{options}}'
);
PlatformCLI.prototype.do_install.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Install the latest Platform Image from the update channel.' +
            'When option --os is not present, it will install latest ' +
            'available Platform Image for both "smartos" and "linux".'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image(s), even if it is ' +
            'not the default one.'
    },
    {
        names: ['os'],
        type: 'string',
        help: 'Operating System for the Platform Image. Either "smartos" or ' +
            '"linux". Only when "--latest" option is provided.'
    }
];

PlatformCLI.prototype.do_install.logToFile = true;


/*
 * Assign a platform image to a particular headnode or computenode.
 */
PlatformCLI.prototype.do_assign =
function do_assign(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var platform = (opts.latest) ? 'latest' : args.shift();
    if (platform === 'help') {
        cb(new errors.UsageError(
        'Please use `sdcadm platform help assign` instead'));
        return;
    }
    var server = args.length ? args : null;
    var assignOpts;

    if (opts.all && server) {
        cb(new errors.UsageError(
            'using --all and explicitly specifying ' +
            'a server are mutually exclusive'));
        return;
    } else if (opts.all) {
        assignOpts = {
            all: true,
            platform: platform,
            progress: self.progress
        };
    } else if (platform && server) {
        assignOpts = {
            server: server,
            platform: platform,
            progress: self.progress
        };
    } else {
        cb(new errors.UsageError(
            'must specify platform and server (or --all)'));
        return;
    }
    // Instead of a single attempt, let's allow retries on platform assignment:
    // self.platform.assign(assignOpts, cb);

    function assignPlatform(options, callback) {
        self.platform.assign(options, callback);
    }

    function assignPlatformCb(err) {
        if (err) {
            p('Platform assign failed');
            cb(err);
            return;
        }
        cb();
    }

    common.execWithRetries({
        func: assignPlatform,
        cb: assignPlatformCb,
        args: assignOpts,
        log: self.log,
        retries: opts.retries
    });
};

PlatformCLI.prototype.do_assign.help = (
    'Assign platform image to the given DC server(s).\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} assign PLATFORM --all\n' +
    '    {{name}} assign PLATFORM [SERVER ...]\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'Where PLATFORM is one of "--latest" (the latest platform image\n' +
    'installed on the USB key) or a "YYYYMMDDTHHMMDDZ" version of an\n' +
    'installed platform (see "sdcadm platform list").\n' +
    '\n' +
    'Use "--all" to assign to all servers or pass a specific set of\n' +
    'SERVERs. A "SERVER" is a server UUID or hostname. In a larger\n' +
    'datacenter, getting a list of the wanted servers can be a chore.\n' +
    'The "sdc-server lookup ..." tool is useful for this.\n' +
    '\n' +
    'Examples:\n' +
    '    # Assign the latest platform to all servers.\n' +
    '    {{name}} assign --latest --all\n' +
    '\n' +
    '    # Assign a specific platform on setup servers with the\n' +
    '    # "pkg=aegean" trait.\n' +
    '    {{name}} assign 20151021T183753Z \\\n' +
    '        $(sdc-server lookup setup=true traits.pkg=aegean)\n' +
    '\n' +
    '    # Assign platform on setup servers excluding servers with\n' +
    '    # a "internal=PKGSRC" trait.\n' +
    '    {{name}} assign 20151021T183753Z \\\n' +
    '        $(sdc-server lookup setup=true \'traits.internal!~PKGSRC\')\n'

);
PlatformCLI.prototype.do_assign.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['all'],
        type: 'bool',
        help: 'Assign the given platform to all servers instead of just ' +
            'the given one(s).'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Assign latest Platform Image.'
    }
];

PlatformCLI.prototype.do_assign.logToFile = true;


PlatformCLI.prototype.do_list =
function do_list(subcmd, opts, _args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var columns = opts.o.trim().split(/\s*,\s*/g);
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.platform.list(function (err, platforms) {
        if (err) {
            return cb(err);
        }

        if (opts.json || opts.jsonstream) {
            if (opts.json) {
                console.log(JSON.stringify(platforms, null, 4));
            } else {
                platforms.forEach(function (k) {
                    process.stdout.write(JSON.stringify(k) + '\n');
                });
            }
            return cb();
        }

        if (opts.usbkey) {
            platforms = platforms.filter(function (plat) {
                return (plat.usb_key);
            });
        }

        var rows = platforms.map(function (k) {
            k.boot_platform = k.boot_platform.length;
            k.current_platform = k.current_platform.length;
            k.default = k.default;
            return k;
        });

        if (opts.active) {
            rows = rows.filter(function (r) {
                return (r.current_platform !== 0 || r.boot_platform !== 0);
            });
        } else if (opts.inactive) {
            rows = rows.filter(function (r) {
                return (r.current_platform === 0 && r.boot_platform === 0);
            });
        }

        var validFieldsMap = {};

        rows.forEach(function (v) {
            var k;
            for (k in v) {
                validFieldsMap[k] = true;
            }
        });

        tabula(rows, {
            skipHeader: opts.H,
            columns: columns,
            sort: sort,
            validFields: Object.keys(validFieldsMap)
        });

        return cb();
    });
};

PlatformCLI.prototype.do_list.help = (
    'Provides a list of Platform Images available to be used.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} list\n' +
    '\n' +
    '{{options}}'
);
PlatformCLI.prototype.do_list.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show platforms list as raw JSON. Other options will not apply'
    },
    {
        names: [ 'jsonstream', 'J' ],
        type: 'bool',
        help: 'new-line separated JSON streaming output'
    },
    {
        names: ['active', 'a'],
        type: 'bool',
        help: 'Do not display Platform Images where current and boot ' +
            'platforms are zero'
    },
    {
        names: ['inactive', 'i'],
        type: 'bool',
        help: 'Display only Platform Images where current and boot ' +
            'platforms are zero'
    },
    {
        names: ['usbkey', 'u'],
        type: 'bool',
        help: 'Display only Platform Images stored in USB Key ' +
            '(do not display images stored only in cache directory)'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'version,current_platform,boot_platform,latest,default,os',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-version,current_platform,boot_platform',
        help: 'Sort on the given fields. Default is ' +
            '"-version,current_platform,boot_platform".',
        helpArg: 'field1,...'
    }
];


PlatformCLI.prototype.do_usage =
function do_usage(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (!args.length) {
        cb(new errors.UsageError(
            'too few args, platform name is required'));
        return;
    }

    opts.platform = args[0];

    if (opts.plaform === 'help') {
        cb(new errors.UsageError(
        'Please use `sdcadm platform help usage` instead'));
        return;
    }

    var columns = opts.o.trim().split(/\s*,\s*/g);
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.platform.usage(opts.platform, function (err, rows) {
        if (err) {
            cb(err);
            return;
        }

        if (rows.length === 0) {
            cb();
            return;
        }

        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
            cb();
            return;
        }
        var validFieldsMap = {};

        rows.forEach(function (v) {
            var k;
            for (k in v) {
                validFieldsMap[k] = true;
            }
        });

        tabula(rows, {
            skipHeader: opts.H,
            columns: columns,
            sort: sort,
            validFields: Object.keys(validFieldsMap)
        });
        cb();
    });
};

PlatformCLI.prototype.do_usage.help = (
    'Provides a list of servers using the given platform.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} usage PLATFORM\n' +
    '\n' +
    '{{options}}'
);

PlatformCLI.prototype.do_usage.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show list as raw JSON. Other options will not apply'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'uuid,hostname,current_platform,boot_platform',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-uuid,hostname,current_platform,boot_platform',
        help: 'Sort on the given fields. Default is ' +
              '"-uuid,hostname,current_platform,boot_platform".',
        helpArg: 'field1,...'
    }
];


PlatformCLI.prototype.do_remove =
function do_remove(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (!args.length && !opts.all) {
        cb(new errors.UsageError('too few args, either platform ' +
                    'name or \'--all\' option are required'));
        return;
    }

    var in_use = [];

    opts.remove = [];
    self.platform.getPlatformsWithServers(function (err, platforms) {
        if (err) {
            cb(err);
            return;
        }

        // When --all is given we will not remove anything requiring the
        // --force flag:
        if (opts.all) {
            Object.keys(platforms).forEach(function (k) {
                if (platforms[k].boot_platform.length === 0 &&
                    platforms[k].current_platform.length === 0) {
                    opts.remove.push(k);
                }
            });

            if (opts.keep_latest) {
                opts.remove.splice(-opts.keep_latest);
            }
        } else {
            args.forEach(function (k) {
                if (platforms[k] &&
                    ((platforms[k].boot_platform.length === 0 &&
                      platforms[k].current_platform.length === 0) ||
                     opts.force)) {
                    opts.remove.push(k);
                } else {
                    if (platforms[k]) {
                        in_use.push(k);
                    }
                }
            });
        }

        if (!opts.remove.length) {
            var msg = 'No platforms will be removed';
            if (in_use.length) {
                msg += '\n\nThe following platforms are in use:\n' +
                    in_use.join('\n') + '\nPlease use `--force` option if ' +
                    'you want to remove them anyway';
            }
            cb(new errors.UsageError(msg));
            return;
        }

        self.platform.getDefaultBootPlatform(function (er1, defPlatform) {
            if (er1) {
                cb(er1);
                return;
            }

            if (opts.remove.indexOf(defPlatform) !== -1) {
                cb(new errors.UsageError(
                            'Default platform cannot be removed'));
                return;
            }

            self.platform.remove(opts, cb);
        });
    });
};

PlatformCLI.prototype.do_remove.help = (
    'Removes the given Platform Image(s).\n' +
    '\n' +
    'When a platform in use by any server is given, the --force option\n' +
    'is mandatory.\n' +
    '\n' +
    'When given, the --all option will remove all the platforms not being\n' +
    'used by any server (neither currently, or configured to boot into).\n' +
    '\n' +
    'Please note that unless the --cleanup-cache option is given, the \n' +
    'Platform Image will remain available to be used at the /usbkey/os \n' +
    'directory and, therefore, will continue appearing into the listing \n' +
    'provided by both CNAPI and sdcadm platform list.\n' +
    '\n' +
    'On these cases, you can re-run this command with the desired platform\n' +
    'images and the --cleanup-cache option, and sdcadm will remove them \n' +
    'from the cache directory.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} remove PLATFORM [PLATFORM2 [PLATFORM3]]\n' +
    '     {{name}} remove --all\n' +
    '\n' +
    '{{options}}'
);
PlatformCLI.prototype.do_remove.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Removes all the platforms not in use.'
    },
    {
        names: ['force'],
        type: 'bool',
        help: 'Remove the given platform despite of being in use.'
    },
    {
        names: ['cleanup-cache'],
        type: 'bool',
        help: 'Also remove the given platform(s) from the on-disk cache.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['keep-latest', 'k'],
        type: 'number',
        help: 'Keep the given number of the most recent platforms. ' +
            '(Requires `--all`)'
    }
];

PlatformCLI.prototype.do_remove.logToFile = true;


PlatformCLI.prototype.do_avail = function do_avail(subcmd, opts, _args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var columns = opts.o.trim().split(/\s*,\s*/g);
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.platform.available(opts, function (err, platforms) {
        if (err) {
            cb(err);
            return;
        }

        if (opts.json || opts.jsonstream) {
            if (opts.json) {
                console.log(JSON.stringify(platforms, null, 4));
            } else {
                platforms.forEach(function (k) {
                    process.stdout.write(JSON.stringify(k) + '\n');
                });
            }
            cb();
            return;
        }
        if (!platforms.length) {
            self.sdcadm.getDefaultChannel(function (er2, channel) {
                // Will not error due to channel not found
                if (er2) {
                    cb();
                    return;
                }
                self.progress('The latest platform image for "%s" channel ' +
                        'is already installed.', channel);
                cb();
            });
        } else {
            var validFieldsMap = {};

            platforms.forEach(function (v) {
                var k;
                for (k in v) {
                    validFieldsMap[k] = true;
                }
            });

            tabula(platforms, {
                skipHeader: opts.H,
                columns: columns,
                sort: sort,
                validFields: Object.keys(validFieldsMap)
            });

            /* eslint-disable callback-return */
            cb();
            /* eslint-enable callback-return */
        }
    });
};

PlatformCLI.prototype.do_avail.aliases = ['available'];

PlatformCLI.prototype.do_avail.help = (
    'Return the list of remotely available Platform Images \n' +
    'published after the latest image installed locally.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} avail\n' +
    '\n' +
    '{{options}}'
);
PlatformCLI.prototype.do_avail.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show platforms list as raw JSON. Other options will not apply'
    },
    {
        names: [ 'jsonstream', 'J' ],
        type: 'bool',
        help: 'new-line separated JSON streaming output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'version,uuid,published_at,os',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-version,uuid,published_at',
        help: 'Sort on the given fields. Default is ' +
            '"-version,uuid,published_at".',
        helpArg: 'field1,...'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image(s), even if it is ' +
            'not the default one.'
    },
    {
        names: ['os'],
        type: 'string',
        help: 'Operating System for the Platform Image. Either "smartos" or ' +
            '"linux". By default available Platform Images for both ' +
            'Operating Systems will be listed.'
    }
];


PlatformCLI.prototype.do_set_default =
function do_set_default(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    opts.platform = (opts.latest) ? 'latest' : args.shift();

    if (!opts.platform) {
        cb(new errors.UsageError(
            'too few args, platform name is required when \'--latest\'' +
            ' option is not given'));
        return;
    }

    if (opts.platform === 'help') {
        cb(new errors.UsageError(
        'Please use `sdcadm platform help set-default` instead'));
        return;
    }


    function setDefPlatform(platform, callback) {
        self.platform.setDefaultBootPlatform(platform, callback);
    }

    function setDefPlatformCb(err, bootParams) {
        if (err) {
            p('Platform set-default failed');
            return cb(err);
        }
        if (opts.platform === 'latest') {
            opts.platform = bootParams.platform + ' (latest)';
        }
        self.progress('Successfully set default platform to %s', opts.platform);
        return cb();
    }

    common.execWithRetries({
        func: setDefPlatform,
        cb: setDefPlatformCb,
        args: opts.platform,
        log: self.log,
        retries: opts.retries
    });
};

PlatformCLI.prototype.do_set_default.help = (
    'Set the default Platform Image for new servers.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} set-default PLATFORM\n' +
    '\n' +
    '{{options}}'
);

PlatformCLI.prototype.do_set_default.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Set default Platform Image to latest installed into USB key.'
    }
];

PlatformCLI.prototype.do_set_default.logToFile = true;


// --- exports

module.exports = {
    PlatformCLI: PlatformCLI,
    Platform: Platform
};
