/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Collection of 'sdcadm platform ...' CLI commands.
 *
 * With the main goal of providing a set of useful tools to operate with
 * HN/CN platforms, the usb key, CNAPI and, in general, all the resources
 * involved into platform management for SDC.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;
var sprintf = require('extsprintf').sprintf;
var tabula = require('tabula');

var vasync = require('vasync');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;


var common = require('./common');
var svcadm = require('./svcadm');
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

// TOOLS-1000: Look at /mnt/usbkey/boot/grub/menu.lst in order to get the real
// platform the HN will boot by default:
Platform.prototype.getHNPlatform = function getHNPlatform(cb) {
    var self = this;
    var hnPlatform;
    vasync.pipeline({funcs: [
        function mountUsbKey(_, next) {
            var argv = ['/usbkey/scripts/mount-usb.sh'];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, next);
        },
        function loadGrubMenuList(_, next) {
            fs.readFile('/mnt/usbkey/boot/grub/menu.lst', {
                encoding: 'utf8'
            }, function (err, data) {
                if (err) {
                    err.cause = 'Read grub menu to load HN default platform';
                    return next(new errors.InternalError(err));
                }
                var defaultSection;
                var sections = data.split('\n\n').filter(function (s) {
                    if (s.search(/title/) === 0) {
                        return true;
                    } else if (s.charAt(0) === '#') {
                        return false;
                    } else {
                        var cfg = s.split('\n');
                        cfg.forEach(function (c) {
                            /* JSSTYLED */
                            var r = c.match(/default (\d+)/);
                            if (r !== null) {
                                defaultSection = Number(r[1]);
                            }
                            return false;
                        });
                    }
                });

                if (!sections[defaultSection]) {
                    return next(new errors.InternalError({
                        message: 'Cannot find default section in grub menu'
                    }));
                }
                var pattern = /\/os\/(\w+)\/platform/;
                var result = sections[defaultSection].match(pattern);
                if (result === null) {
                    return next(new errors.InternalError({
                        message: 'Cannot find default platform in grub menu'
                    }));
                }

                hnPlatform = result[1];
                next();
            });
        },
        function unmountUsbKey(_, next) {
            var argv = ['/usr/sbin/umount', '/mnt/usbkey'];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, next);
        }

    ]}, function _pipelineCb(err) {
        cb(err, hnPlatform);
    });
};


Platform.prototype.listUSBKeyPlatforms = function listUSBKeyPlatforms(cb) {
    var self = this;
    var usbKeyPlatforms;
    vasync.pipeline({funcs: [
        function mountUsbKey(_, next) {
            var argv = ['/usbkey/scripts/mount-usb.sh'];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, next);
        },
        function getPlatformList(_, next) {
            var argv = [ 'ls', '/mnt/usbkey/os' ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    return next(err);
                }
                var ary = stdout.trim().split('\n');
                usbKeyPlatforms = ary.sort(function (a, b) {
                    return a.localeCompare(b);
                }).filter(function (i) {
                    return (i !== 'latest');
                }).map(function (i) {
                    return (i.toUpperCase());
                });

                return next(null);
            });
        },
        function unmountUsbKey(_, next) {
            var argv = ['/usr/sbin/umount', '/mnt/usbkey'];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, next);
        }

    ]}, function _pipelineCb(err) {
        cb(err, usbKeyPlatforms);
    });
};


Platform.prototype.getPlatformsWithServers =
function getPlatformsWithServers(cb) {
    var self = this;
    var latest;

    self.getHNPlatform(function (er1, hnPlatform) {
        if (er1) {
            // Log the error reading from GRUB and just go ahead with CNAPI
            self.log.debug({
                err: er1
            }, 'Error reading HN platform from grub menu');
        }

        self.sdcadm.cnapi.listPlatforms(function (err, platforms) {
            if (err) {
                return cb(new errors.SDCClientError(err, 'cnapi'));
            }
            if (Array.isArray(platforms) && !platforms.length) {
                return cb(new errors.UpdateError('no platforms found'));
            }

            self._rawPlatforms = platforms;

            self.sdcadm.cnapi.listServers({
                setup: true
            }, function (er2, servers) {
                if (er2) {
                    return cb(new errors.SDCClientError(er2, 'cnapi'));
                }
                if (Array.isArray(servers) && !servers.length) {
                    return cb(new errors.UpdateError('no servers found'));
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

                        if (s.headnode) {
                            s.boot_platform = hnPlatform;
                        }

                        if (platforms[s.boot_platform]) {
                            platforms[s.boot_platform].boot_platform.push({
                                uuid: s.uuid,
                                hostname: s.hostname
                            });
                        }

                        if (platforms[s.current_platform]) {
                            platforms[s.current_platform].current_platform.
                                push({
                                uuid: s.uuid,
                                hostname: s.hostname
                            });
                        }

                        next();
                    }
                }, function (er3, results) {
                    if (er3) {
                        return cb(new errors.InternalError(
                                    'Error fetching platforms servers'));
                    }
                    return cb(null, platforms);
                });
            });
        });
    });
};


// Get version for latest platform image installed into usbkey cache.
// cb(err, latest)
Platform.prototype.getLatestPlatformInstalled =
function getLatestPlatformInstalled(cb) {
    var self = this;
    self.listUSBKeyPlatforms(function (err, platforms) {
        if (err) {
            return cb(err);
        }
        var latest = platforms.pop();
        return cb(null, latest);
    });
};

// TODO: svcprop -p 'joyentfs/usb_copy_path' \
//          svc:/system/filesystem/smartdc:default
Platform.prototype.createLatestLink =
function createLatestLink(cb) {
    var self = this;

    self.getCNAPIVersion(function (err, version) {
        if (err) {
            return cb(err);
        }
        // Do nothing if we've already deprecated latest in CNAPI
        if (version >= MIN_CNAPI_VERSION_NO_LATEST) {
            return cb();
        }

        self.progress('Updating \'latest\' link');
        var argv = [ 'rm', '-f', '/usbkey/os/latest' ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err1, stdout1, stderr1) {
            if (err1) {
                return cb(err1);
            }
            self.getLatestPlatformInstalled(function (err2, latest) {
                if (err2) {
                    return cb(err2);
                }
                argv = ['ln', '-s', latest, 'latest'];
                common.execFilePlus({
                    argv: argv,
                    cwd: '/usbkey/os',
                    log: self.log
                }, function (err3, stdout3, stderr3) {
                    if (err3) {
                        return cb(err3);
                    }
                    return cb();
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

    var self = this;

    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    self.getLatestPlatformInstalled(function (err2, latest) {
        if (err2) {
            return cb(err2);
        }
        var filter = {
            name: 'platform'
        };
        self.sdcadm.updates.listImages(filter, function (err, images) {
            if (err) {
                return cb(new errors.SDCClientError(err, 'updates'));
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            images = images.map(function (img) {
                return ({
                    version: img.version.split('-').pop(),
                    uuid: img.uuid,
                    published_at: img.published_at
                });
            }).filter(function (i) {
                return (i.version > latest);
            });
            return cb(null, images);
        });
    });
};


Platform.prototype.list = function list(cb) {
    var self = this;
    self.getDefaultBootPlatform(function (er1, defPlatform) {
        if (er1) {
            return cb(er1);
        }
        self.getPlatformsWithServers(function (err, platforms) {
            if (err) {
                return cb(err);
            }

            self.listUSBKeyPlatforms(function (er2, usbKeyPlatforms) {
                if (er2) {
                    return cb(er2);
                }

                platforms = Object.keys(platforms).map(function (k) {
                    return {
                        version: k,
                        boot_platform: platforms[k].boot_platform,
                        current_platform: platforms[k].current_platform,
                        latest: platforms[k].latest || false,
                        default: (k === defPlatform),
                        usb_key: (usbKeyPlatforms.indexOf(k) !== -1)
                    };
                });

                return cb(null, platforms);
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

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var filepath;
    var image;
    var progress = self.progress;
    var changes = [];
    var hist;
    var latest;
    // TOOLS-876: Keep track of when an error happened during downloads, in
    // order to avoid suggesting the user to re-run a bogus file
    var downloadError = false;
    // TOOLS-1206: Keep track of when an error happened trying to find an
    // image in order to avoid same thing than for TOOLS-876
    var imgNotFoundError = false;

    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    function findPlatformImageLatest(cb) {
        var filter = {
            name: 'platform'
        };
        self.sdcadm.updates.listImages(filter, function (err, images) {
            if (err) {
                imgNotFoundError = true;
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                imgNotFoundError = true;
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];

            cb();
        });
        return;
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

    function findPlatformBySearching(cb) {
        var filter = {
            name: 'platform',
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
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];
            cb();
        });
        return;
    }

    function downloadPlatformImage(cb) {
        var realVersion = image.version.split('-').pop();
        progress(format(
            'Downloading platform %s (image %s) to %s', realVersion,
            image.uuid, filepath));

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
            if (code) {
            // TOOLS-1012: Most of the times, the reason for installer failure
            // is ENOSPC. Let's check USB key disk space when installer fails
                common.execFilePlus({
                    argv: ['/usr/bin/df', '-k', '/mnt/usbkey/os'],
                    log: self.log
                }, function (err, stdout, stderr) {
                    stdout = stdout.trim().split('\n');
                    stdout = stdout[1].split(/\s+/);
                    var avail = stdout[3];
                    if (avail) {
                        avail = avail / 1024;
                        self.progress('Please check that USB key has free ' +
                                'space enough to unpack platform file');
                        self.progress('Available disk space in USB key is %d ' +
                                'MiB', avail.toFixed(0));
                    }
                    return cb(new Error(INSTALL_PLATFORM + ' returned ' +
                                code));
                });
            } else {
                progress('Platform installer finished successfully');
                progress('Proceeding to complete the update');
                cb();
            }
        });
    }

    function updateHistory(history, cb) {
        if (!history) {
            self.sdcadm.log.debug('History not set for platform install');
            return cb();
        }
        return self.sdcadm.history.updateHistory(history, cb);
    }

    function cleanup(cb) {
        fs.unlink(filepath, function (err) {
            if (err) {
                self.log.warn(err, 'unlinking %s', filepath);
            }
            progress('Installation complete');
            return updateHistory(hist, cb);
        });
    }

    vasync.pipeline({funcs: [
        function getChannel(_, next) {
            self.sdcadm.getDefaultChannel(function (err, channel) {
                // Will not fail the whole operation due to channel not found
                if (err) {
                    return next();
                }
                if (!fs.existsSync(opts.image)) {
                    progress('Using channel %s', channel);
                }
                return next();
            });
        },
        function findLatest(_, next) {
            self.getLatestPlatformInstalled(function (err, platf) {
                if (err) {
                    return next(err);
                }
                latest = platf;
                return next();
            });
        },
        // Make sure that if we install a new platform and Headnode is using
        // "latest", we really know what we're doing:
        function checkHeadnodePlatform(_, next) {
            if (opts.yes) {
                return next();
            }
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, res) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                var hn_uuid = res[0].uuid;
                self.sdcadm.cnapi.getBootParams(hn_uuid, function (er2, boot) {
                    if (er2) {
                        return next(new errors.SDCClientError(er2, 'cnapi'));
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
                        return callback();

                    } else {
                        return next();
                    }
                });
            });
        },
        function findPlatformImage(_, next) {
            // Check if the value of the parameter `image` is a file
            if (fs.existsSync(opts.image)) {
                filepath = opts.image;
                deleteOnFinish = false;
                return next();
            } else if (opts.image === 'latest') {
                return findPlatformImageLatest(next);
            } else if (opts.image.match(
                /([a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}?)/ig))
            {
                return findPlatformImageByUuid(next);
            } else {
                return findPlatformBySearching(next);
            }
        },

        function verifyLatesltIsNotAlreadyInstalled(_, next) {
            if (opts.image !== 'latest') {
                return next();
            }
            progress('Checking latest Platform Image is already installed');

            var realVersion = image.version.split('-').pop();
            if (realVersion === latest) {
                progress('Latest Platform Image already installed');
                return callback(null);
            } else {
                return next();
            }
        },

        function saveChangesToHistory(_, next) {
            var change = {
                service: {
                    name: 'platform'
                },
                type: 'install-platform'
            };
            if (filepath) {
                change.file = filepath;
            } else {
                change.img = image;
            }
            changes.push(change);

            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function downloadImage(_, next) {
            if (filepath) {
                progress(format('Using platform file %s', filepath));
                next();
            } else {
                filepath = format('%s/platform-%s.tgz',
                                  localdir, image.version);
                downloadPlatformImage(next);
            }
        },
        function execInstaller(_, next) {
            executeInstallerFile(next);
        },
        function linkLatest(_, next) {
            self.createLatestLink(next);
        },
        function updateBootParams(_, next) {
            self.setDefaultBootPlatform(next);
        }
    ]}, function pipelineCb(err) {
        if (err) {
            if (hist) {
                hist.error = err;
            }
            progress('Error: %s', err.message);
            if (downloadError) {
                progress('Please re-run `sdcadm platform install` with ' +
                        'the same options in order to attempt to ' +
                        'successfully download the image.');
            } else if (imgNotFoundError) {
                progress('Unable to find the given Platform Image \'%s\' ' +
                        'in channel \'%s\'', opts.image,
                        self.sdcadm.updates.channel);
            } else {
                progress('In order not to have to re-download image, ' +
                         '%s has been left behind.', filepath);
                progress('After correcting above problem, rerun ' +
                         '`sdcadm platform install %s`.', filepath);
            }
            return updateHistory(hist, callback);
        }

        if (deleteOnFinish) {
            return cleanup(callback);
        } else {
            progress('Platform image explicitly specified; ' +
                     'will not delete %s', filepath);
            progress('Installation complete');
        }

        return updateHistory(hist, callback);
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
    // Used by sdcadm history:
    var changes = [];
    var hist;

    vasync.pipeline({funcs: [
        function getBootParams(_, next) {
            self.sdcadm.cnapi.getBootParams('default', function (err, params) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                bootParams = params;
                return next();
            });
        },
        function getPlatformsList(_, next) {
            if (self._rawPlatforms.length) {
                return next();
            }
            self.sdcadm.cnapi.listPlatforms(function (err, platforms) {
                if (err) {
                    return next(err);
                }

                self._rawPlatforms = platforms;
                return next();
            });
        },
        function verifyPlatformExists(_, next) {
            if (version === 'latest') {
                return next();
            }

            if (Object.keys(self._rawPlatforms).indexOf(version) === -1) {
                return next(new errors.UsageError(
                    'Invalid platform version: ' + version));
            }
            return next();
        },
        function getLatestPlatformVersion(_, next) {
            if (version !== 'latest') {
                return next();
            }
            Object.keys(self._rawPlatforms).forEach(function (pl) {
                if (self._rawPlatforms[pl].latest) {
                    latestPlatform = pl;
                }
            });
            return next();
        },
        function saveChangesToHistory(_, next) {
            changes.push({
                service: {
                    name: 'platform'
                },
                type: 'default-platform',
                version: (latestPlatform ? latestPlatform : version)
            });
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },
        function setDefaultBootParams(_, next) {
            if (version === 'latest' && bootParams.platform !== 'latest') {
                return next();
            }
            self.progress(
                'Updating default boot platform to \'%s\'',
                (latestPlatform ? latestPlatform : version));
            self.sdcadm.cnapi.setBootParams('default', {
                platform: (latestPlatform ? latestPlatform : version)
            }, function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                return next();
            });
        }
    ]}, function pipeCb(err) {
        if (!hist) {
            self.sdcadm.log.warn('History not set for default platform');
            return cb(err);
        }
        if (err) {
            hist.error = err;
        }
        self.sdcadm.history.updateHistory(hist, function (err2) {
            if (err) {
                return cb(err);
            } else if (err2) {
                return cb(err2);
            } else {
                return cb(null, bootParams);
            }
        });
    });
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
                    return next(err);
                }
                isVersionOk = (version >= MIN_CNAPI_VERSION_NO_LATEST);
                return next();
            });
        },
        function getBootParams(_, next) {
            if (!isVersionOk) {
                return next();
            }
            self.sdcadm.cnapi.getBootParams('default', function (err, params) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                bootParams = params;
                return next();
            });
        },
        function getLatestPlatformVersion(_, next) {
            if (!isVersionOk) {
                return next();
            }
            if (!self._usingLatest.length &&
                    (bootParams.platform !== 'latest')) {
                return next();
            }
            Object.keys(self._rawPlatforms).forEach(function (pl) {
                if (self._rawPlatforms[pl].latest) {
                    latestPlatform = pl;
                }
            });
            return next();
        },
        function setDefBootParams(_, next) {
            if (!isVersionOk || bootParams.platform !== 'latest') {
                return next();
            }
            self.progress(
                'Updating default boot platform from \'latest\' to \'%s\'',
                latestPlatform);
            self.sdcadm.cnapi.setBootParams('default', {
                platform: latestPlatform
            }, function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                return next();
            });
        },
        function updateCNs(_, next) {
            if (!isVersionOk || !self._usingLatest.length) {
                return next();
            }
            self.progress('Updating boot platform  from \'latest\' to' +
                    '\'%s\' for CNs %s', latestPlatform,
                    self._usingLatest.join(','));
            // We need to empty self._usingLatest to prevent an infinite loop:
            var cns = self._usingLatest.slice();
            self._usingLatest = [];

            return self.assign({
                platform: latestPlatform,
                server: cns
            }, next);
        },
        function removeLatestSymlink(_, next) {
            self.progress('Removing \'latest\' link');
            var argv = [ 'rm', '-f', '/usbkey/os/latest' ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err1, stdout1, stderr1) {
                if (err1) {
                    return next(err1);
                }
                return next();
            });
         }
    ]}, function (error) {
        return callback(error);
    });
};

/**
 * Returns the relevant 8 digits of the CNAPI image version for the first
 * found CNAPI instance. (YYYYMMDD)
 * TODO (pedro): There are three modules using this for diferent services,
 * some refactoring and using it from lib/common.js would be great.
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
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                img = obj.imgs[0];
                return next();
            });
        },

        function getCnapiVersion(_, next) {
            var splitVersion = img.version.split('-');

            if (splitVersion[0] === 'master') {
                version = splitVersion[1].substr(0, 8);
            } else if (splitVersion[0] === 'release') {
                version = splitVersion[1];
            }

            return next();
        }
    ]}, function pipeCb(err) {
        return callback(err, version);
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
        return callback(new Error('must specify a SERVER or --all'));
    }

    var serverRecs = [];
    var assignServers = [];
    var uuids = [];
    var headnode;
    var progress = self.progress;
    // Used by sdcadm history:
    var changes = [];
    var hist;
    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    var errs = [];


    function updateBooterCache(servers, cb) {
        var macs;
        var serveruuids = servers.map(function (server) {
            return server.uuid;
        });

        progress('Updating booter cache for servers');

        vasync.pipeline({funcs: [
            function (_, next) {
                var listOpts = {
                    belongs_to_type: 'server',
                    nic_tags_provided: 'admin'
                };
                if (!opts.all) {
                    listOpts.belongs_to_uuid = serveruuids;
                }
                self.sdcadm.napi.listNics(listOpts, {}, function (err, nics) {
                    if (err) {
                        return next(err);
                    }

                    macs = nics.map(function (nic) {
                        return nic.mac;
                    });

                    next();
                });
            },
            function (_, next) {
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
                }, next);
            }
        ]}, function (err) {
            progress('Done updating booter caches');
            cb(err);
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
        progress(
            'updating computenode %s to %s',
            server.uuid, opts.platform);

        progress('Setting cn boot params for %s', server.uuid);
        self.sdcadm.cnapi.setBootParams(server.uuid, {
            platform: opts.platform
        }, {}, function (err) {
            if (err) {
                errs.push(new errors.SDCClientError(err, 'cnapi'));
            }
            cb(err);
        });
    }

    vasync.pipeline({funcs: [
        function findLatest(_, next) {
            if (opts.platform !== 'latest') {
                return next();
            }
            self.getLatestPlatformInstalled(function (err2, latest) {
                if (err2) {
                    return next(err2);
                }
                opts.platform = latest;
                return next();
            });
        },
        function validatePlatform(_, next) {
            self.sdcadm.cnapi.listPlatforms(function (err, platforms) {
                if (err) {
                    return next(err);
                }

                self._rawPlatforms = platforms;

                if (Object.keys(platforms).indexOf(opts.platform) === -1) {
                    return callback(
                        new Error(format(
                            'invalid platform %s', opts.platform)));
                }
                next();
            });
        },
        function serverList(_, next) {

            self.sdcadm.cnapi.listServers({
                setup: true
            }, function (err, recs) {
                if (err) {
                    return next(err);
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
                    opts.server.indexOf(server.uuid) !== -1)
                {
                    assignServers.push(server);
                } else {
                    if (server.boot_platform === 'latest' ||
                            server.current_platform === 'latest') {
                        self._usingLatest.push(server.uuid);
                    }
                }

            });

            if (opts.server && !assignServers.length) {
                return next(
                    new Error(format(
                        'server %j not found', opts.server)));
            }

            next();
        },
        function applyExcludeContidions(_, next) {
            if (!opts.exclude || !opts.all) {
                return next();
            }
            var excludedServers = [];
            // Note we could risk and use javascript's "eval" here. Don't
            // do that for now and just limit our options to a very defined
            // set of known possibilities in order to avoid issues executing
            // arbitrary code.
            function filterExclude(server) {
                /* JSSTYLED */
                var re = /([^=!]+)([=|!]==)([^=!]+)/;
                var exclude = false;

                opts.exclude.forEach(function (opt) {
                    // Skip if already excluded by a previous option;
                    if (exclude) {
                        return;
                    }
                    var res = re.exec(opt);
                    if (res === null) {
                        return;
                    }

                    var prop = res[1].trim();
                    var operator = res[2];
                    var value = res[3].trim();

                    if (operator !== '!==' && operator !== '===') {
                        return next(new errors.UsageError(
                            'Invalid exclude operator \'%s\'. Allowed ' +
                            'operators are \'===\' and \'!==\'', operator));
                    }

                    var serverProp;
                    // Allow up to any level of server nested object props:
                    if (prop.indexOf('.') !== -1) {
                        var props = prop.split('.');
                        serverProp = server[props.shift()];
                        while (serverProp && props.length) {
                            serverProp = serverProp[props.shift()];
                        }
                    } else {
                        serverProp = server[prop];
                    }

                    // If the property is not defined, then it'll be different
                    // to whatever the value if operator is '!==':
                    if (typeof (serverProp) === 'undefined') {
                        if (operator === '!==') {
                            exclude = true;
                        }
                        return;
                    }

                    // Typecast value (boolean, number, string):
                    var castValue;
                    switch (value) {
                    case 'true':
                    case 'false':
                        castValue = Boolean(value);
                        break;
                    case !isNaN(Number(value)):
                        castValue = Number(value);
                        break;
                    default:
                        // Assume string by default. Might want to improve for
                        // date/time values in the future:
                        /* JSSTYLED */
                        castValue = value.replace(/^"/g, '').replace(/"$/g, '');
                        break;
                    }

                    var condition = (operator === '!==') ?
                        (serverProp !== castValue) :
                        (serverProp === castValue);

                    if (condition) {
                        exclude = true;
                    }
                    return;
                });

                if (exclude) {
                    excludedServers.push(server);
                }

                return (!exclude);
            }

            assignServers = assignServers.filter(filterExclude);
            if (excludedServers.length) {
                self.log.debug({
                    excluded: excludedServers,
                    exclude: opts.exclude
                }, 'Excluded servers');
            }
            return next();
        },
        function saveChangesToHistory(_, next) {
            uuids = assignServers.map(function (s) {
                return (s.uuid);
            });
            changes.push({
                service: {
                    name: 'platform'
                },
                type: 'assign-platform',
                servers: uuids
            });
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
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
                return next();
            }
            progress('Verifying boot_platform updates');
            self.sdcadm.cnapi.listServers({
                uuids: uuids.join(',')
            }, function (err, updated) {
                if (err) {
                    return next(err);
                }
                var updateErrs = [];
                updated.forEach(function (u) {
                    if (u.boot_platform !== opts.platform) {
                        updateErrs.push(u.uuid);
                    }
                });
                if (updateErrs.length) {
                    var msg = 'The following servers were not updated: ' +
                        updateErrs.join(',');
                    return next(new errors.SDCClientError({
                        message: msg
                    }, 'cnapi'));
                }
                return next();
            });
        },
        function callDeprecateLatest(_, next) {
            return self.deprecateLatest(next);
        },
        function setDefault(_, next) {
            if (!opts.all) {
                return next();
            }
            return self.setDefaultBootPlatform(opts.platform, next);
        }
    ]},
    function (err) {
        if (errs.length) {
            err = new errors.MultiError(errs);
        }
        if (!hist) {
            self.sdcadm.log.warn('History not set for platform assign');
            return callback(err);
        }
        if (err) {
            hist.error = err;
        }
        self.sdcadm.history.updateHistory(hist, function (err2) {
            if (err) {
                return callback(err);
            } else if (err2) {
                return callback(err2);
            } else {
                return callback();
            }
        });
    });
};


Platform.prototype.usage = function (platform, cb) {
    var self = this;
    assert.string(platform, 'platform');

    self.getHNPlatform(function (er1, hnPlatform) {
        if (er1) {
            // Log the error reading from GRUB and just go ahead with CNAPI
            self.log.error({
                err: er1
            }, 'Error reading HN platform from grub menu');
        }

        self.sdcadm.cnapi.listPlatforms(function (err, platforms) {
            if (err) {
                return cb(new errors.SDCClientError(err, 'cnapi'));
            }
            if (Array.isArray(platforms) && !platforms.length) {
                return cb(new errors.UpdateError('no platforms found'));
            }
            if (Object.keys(platforms).indexOf(platform) === -1) {
                return cb(
                    new Error(format(
                        'invalid platform %s', platform)));
            }
            self.sdcadm.cnapi.listServers({
                setup: true
            }, function (er2, servers) {
                if (er2) {
                    return cb(new errors.SDCClientError(er2, 'cnapi'));
                }
                if (Array.isArray(servers) && !servers.length) {
                    return cb(new errors.UpdateError('no servers found'));
                }

                var rows = [];

                vasync.forEachParallel({
                    inputs: servers,
                    func: function (s, next) {
                        if (s.headnode) {
                            s.boot_platform = hnPlatform;
                        }
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
                }, function (er3, results) {
                    if (er3) {
                        return cb(er3);
                    }
                    return cb(null, rows);
                });
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

    var changes = [];
    var hist;

    vasync.pipeline({funcs: [
        function confirm(_, next) {
            p('');
            p('The following Platform Images will be removed:');
            p(common.indent(opts.remove.join('\n')));
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    return cb();
                }
                p('');
                return next();
            });
        },

        function saveChangesToHistory(_, next) {
            changes.push({
                service: {
                    name: 'platform'
                },
                type: 'remove',
                platforms: opts.remove
            });
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (er4, hst) {
                if (er4) {
                    return next(er4);
                }
                hist = hst;
                return next();
            });
        },

        function mountUsbKey(_, next) {
            p('Mounting USB key');
            var argv = ['/usbkey/scripts/mount-usb.sh'];
            common.execFilePlus({argv: argv, log: self.sdcadm.log}, next);
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
                return next();
            });
        },

        function unmountUsbKey(_, next) {
            p('Unmounting USB key');
            var argv = ['/usr/sbin/umount', '/mnt/usbkey'];
            common.execFilePlus({argv: argv, log: self.sdcadm.log}, next);
        },

        // TODO: svcprop -p 'joyentfs/usb_copy_path' \
        //          svc:/system/filesystem/smartdc:default
        function removePlatformsCache(_, next) {
            if (!opts.cleanup_cache) {
                return next();
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
                return next();
            }
            p('Updating \'latest\' link');
            return self.createLatestLink(next);
        }
    ]}, function (er2) {
        if (!hist) {
            self.sdcadm.log.warn('History not set for platform remove');
            return cb(er2);
        }
        if (er2) {
            hist.error = er2;
        }
        p('Done.');
        self.sdcadm.history.updateHistory(hist, function (err2) {
            if (er2) {
                return cb(er2);
            } else if (err2) {
                return cb(err2);
            } else {
                return cb();
            }
        });
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

PlatformCLI.prototype.init = function init(opts, args, callback) {
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
        return cb(new errors.UsageError(
            'must specify Platform Image UUID or --latest'));
    }

    if (args[0] && args[0] === 'help') {
        return cb(new errors.UsageError(
            'Please use `sdcadm platform help install` instead'));
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
    self.platform.install(options, cb);
};

PlatformCLI.prototype.do_install.help = (
    'Download and install Platform Image for later assignment.\n' +
    '\n' +
    'Please note that installing a new Platform Image will not\n' +
    'assign this image to any server. Install will download the\n' +
    'image, put it on the head node USB key (/mnt/usbkey/os)\n' +
    'and copy it back to the platform cache directory (/usbkey/os).\n' +
    'The image is made available through CNAPI for later assignment.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} install IMAGE-UUID\n' +
    '     {{name}} install PATH-TO-IMAGE\n' +
    '     {{name}} install --latest\n' +
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
        help: 'Install the latest Platform Image from the update channel.'
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
    }
];



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
    }
    var server = args.length ? args : null;
    var assignOpts;

    if (opts.all && server) {
        return cb(new errors.UsageError(
            'using --all and explicitly specifying ' +
            'a server are mutually exclusive'));
    } else if (opts.all) {
        assignOpts = {
            all: true,
            platform: platform,
            progress: self.progress,
            exclude: opts.exclude
        };
    } else if (platform && server) {
        assignOpts = {
            server: server,
            platform: platform,
            progress: self.progress
        };
    } else {
        return cb(new errors.UsageError(
            'must specify platform and server (or --all)'));
    }
    self.platform.assign(assignOpts, cb);
};
PlatformCLI.prototype.do_assign.help = (
    'Assign Platform Image to the given SDC server(s).\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} assign PLATFORM SERVER1 [ SERVER2 [SERVER3] ]\n' +
    '     {{name}} assign PLATFORM --all\n' +
    '     {{name}} assign --latest SERVER1 [ SERVER2 [SERVER3] ]\n' +
    '     {{name}} assign --latest --all\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'Exclude examples:\n' +
    '     -x \'traits.internal === "Manta Node"\'\n' +
    '     -x \'traits.internal !== "PKGSRC Development"\'\n' +
    '     -x \'headnode === false\''
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
        help: 'Assign given Platform Image to all servers instead of just ' +
            'the given one(s).'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Assign latest Platform Image.'
    },
    {
        names: ['exclude', 'x'],
        type: 'arrayOfString',
        help: 'Exclude the servers matching the given conditions.\n' +
            'Only used when provided together with `--all` option.\n' +
            'On the left side of the exclude expression any server ' +
            'property can be used.\n Allowed comparision operators are ' +
            'only \'===\' and \'!==\'. At the right side of the operator ' +
            'an arbitrary string, a boolean or a number can be used.'
    }
];


PlatformCLI.prototype.do_list =
function do_list(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
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
        default: 'version,current_platform,boot_platform,latest,default',
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
        return cb(new errors.UsageError(
            'too few args, platform name is required'));
    }

    opts.platform = args[0];

    if (opts.plaform === 'help') {
        cb(new errors.UsageError(
        'Please use `sdcadm platform help usage` instead'));
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.platform.usage(opts.platform, function (err, rows) {
        if (err) {
            return cb(err);
        }

        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
            return cb();
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
        return cb(new errors.UsageError('too few args, either platform ' +
                    'name or \'--all\' option are required'));
    }

    var in_use = [];

    opts.remove = [];
    self.platform.getPlatformsWithServers(function (err, platforms) {
        if (err) {
            return cb(err);
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
            return cb(new errors.UsageError(msg));
        }

        self.platform.getDefaultBootPlatform(function (er1, defPlatform) {
            if (er1) {
                return cb(er1);
            }

            if (opts.remove.indexOf(defPlatform) !== -1) {
                return cb(new errors.UsageError(
                            'Default platform cannot be removed'));
            }

            return self.platform.remove(opts, cb);
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


PlatformCLI.prototype.do_avail = function do_avail(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.platform.available(opts, function (err, platforms) {
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

        return cb();
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
        default: 'version,uuid,published_at',
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
        return cb(new errors.UsageError(
            'too few args, platform name is required when \'--latest\'' +
            ' option is not given'));
    }

    if (opts.plaform === 'help') {
        cb(new errors.UsageError(
        'Please use `sdcadm platform help set-default` instead'));
    }

    vasync.pipeline({funcs: [
        function getLatest(_, next) {
            if (!opts.latest) {
                next();
            } else {
                self.platform.getLatestPlatformInstalled(
                        function (er1, latest) {
                    if (er1) {
                        return next(er1);
                    }
                    opts.platform = latest;
                    return next();
                });
            }
        },
        function setDefault(_, next) {
            self.platform.setDefaultBootPlatform(opts.platform, next);
        }
    ]}, function (err) {
        if (err) {
            return cb(err);
        }
        self.progress('Successfully set default platform to %s', opts.platform);
        return cb();
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

//---- exports

module.exports = {
    PlatformCLI: PlatformCLI
};
