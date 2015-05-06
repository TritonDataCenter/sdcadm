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
var read = require('read');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;


var common = require('./common');
var svcadm = require('./svcadm');
var errors = require('./errors');

// --- globals


// --- Platform class
// Intended to be used either from the PlatformCLI class, or from whatever
// else using sdcadm, not necessarily a cmdln tool.

function Platform(top) {
    this.top = top;
    this.sdcadm = top.sdcadm;
    this.progress = top.progress;
    this.log = top.log;
}


Platform.prototype.getPlatformsWithServers =
function getPlatformsWithServers(cb) {
    var self = this;
    var latest;

    self.sdcadm.cnapi.listPlatforms(function (err, platforms) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'cnapi'));
        }
        if (Array.isArray(platforms) && !platforms.length) {
            return cb(new errors.UpdateError('no platforms found'));
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
                    }

                    if (s.current_platform === 'latest') {
                        s.current_platform = latest;
                    }

                    if (platforms[s.boot_platform]) {
                        platforms[s.boot_platform].boot_platform.push({
                            uuid: s.uuid,
                            hostname: s.hostname
                        });
                    }

                    if (platforms[s.current_platform]) {
                        platforms[s.current_platform].current_platform.push({
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
};


Platform.prototype.list = function list(cb) {
    var self = this;
    self.getPlatformsWithServers(function (err, platforms) {
        if (err) {
            return cb(err);
        }

        platforms = Object.keys(platforms).map(function (k) {
            return {
                version: k,
                boot_platform: platforms[k].boot_platform,
                current_platform: platforms[k].current_platform,
                latest: platforms[k].latest || false
            };
        });

        return cb(null, platforms);
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
    // TOOLS-876: Keep track of when an error happened during downloads, in
    // order to avoid suggesting the user to re-run a bogus file
    var downloadError = false;

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
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
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
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
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
        progress('Installing platform image onto USB key');
        var INSTALL_PLATFORM = '/usbkey/scripts/install-platform.sh';
        var child = spawn(
            INSTALL_PLATFORM, [ filepath ],
            { stdio: 'inherit' });

        child.on('exit', function (code) {
            if (code) {
                return cb(new Error(INSTALL_PLATFORM + ' returned ' + code));
            }
            progress('Platform installer finished successfully');
            progress('Proceeding to complete the update');
            cb();
        });
    }

    // TODO: svcprop -p 'joyentfs/usb_copy_path' \
    //          svc:/system/filesystem/smartdc:default
    function createLatestLink(cb) {
        progress('Updating \'latest\' link');
        var argv = [ 'rm', '-f', '/usbkey/os/latest' ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err1, stdout1, stderr1) {
            if (err1) {
                return cb(err1);
            }
            argv = [ 'ls', '/usbkey/os' ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err2, stdout2, stderr2) {
                if (err2) {
                    return cb(err2);
                }
                var ary = stdout2.split('\n');
                ary.pop();
                var latest = ary.pop();
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
    }

    function updateHistory(history, cb) {
        if (!history) {
            self.sdcadm.log.warn('History not set for platform install');
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
                        progress('Headnode is using \'latest\' platform. ' +
                            'Installing a new platform may change the ' +
                            '\'latest\' symlink.');
                        progress('');

                        var msg = 'Would you like to continue anyway? [y/N] ';
                        common.promptYesNo({
                            msg: msg,
                            default: 'n'
                        }, function (answer) {
                            if (answer !== 'y') {
                                progress('Aborting platform install');
                                return callback();
                            }
                            progress('');
                            return next();
                        });

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
            createLatestLink(next);
        }
    ]}, function pipelineCb(err) {
        if (err) {
            if (hist) {
                hist.error = err;
            }
            progress('Error: %s', err.message);
            if (downloadError) {
                progress('Please, re-run `sdcadm platform install` with ' +
                        'the same options in order to attempt to ' +
                        'successfully download the image.');
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
                    '/usbkey/scripts/switch-platform.sh %s\n' +
                    'cd /usbkey/os\n' +
                    'rm latest; ln -s %s latest',
                    opts.platform, opts.platform);

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
        function validatePlatform(_, next) {
            self.sdcadm.cnapi.listPlatforms(function (err, platforms) {
                if (err) {
                    return next(err);
                }
                if (opts.platform === 'latest') {
                    opts.platform = Object.keys(platforms).filter(
                        function (k) {
                        return (platforms[k].latest === true);
                    })[0];
                }

                if (Object.keys(platforms).indexOf(opts.platform) === -1) {
                    return callback(
                        new Error(format(
                            'invalid platform %s', opts.platform)));
                }
                next();
            });
        },
        function serverList(_, next) {
            self.sdcadm.cnapi.listServers(function (err, recs) {
                if (err) {
                    return next(err);
                }
                serverRecs = recs;

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
                }
            });

            if (opts.server && !assignServers.length) {
                return next(
                    new Error(format(
                        'server %j not found', opts.server)));
            }

            next();
        },
        function saveChangesToHistory(_, next) {
            changes.push({
                service: {
                    name: 'platform'
                },
                type: 'assign-platform',
                servers: assignServers
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
            var uuids = assignServers.map(function (s) {
                return (s.uuid);
            });
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
                    return next(new errors.SDCClientError(msg, 'cnapi'));
                }
                return next();
            });
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
            p('The following platform images will be removed:');
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
        function createLatestLink(_, next) {
            if (!opts.cleanup_cache) {
                return next();
            }
            p('Updating \'latest\' link');
            var argv = [ 'rm', '-f', '/usbkey/os/latest' ];
            common.execFilePlus({
                argv: argv,
                log: self.sdcadm.log
            }, function (err1, stdout1, stderr1) {
                if (err1) {
                    return next(err1);
                }
                argv = [ 'ls', '/usbkey/os' ];
                common.execFilePlus({
                    argv: argv,
                    log: self.sdcadm.log
                }, function (err2, stdout2, stderr2) {
                    if (err2) {
                        return next(err2);
                    }
                    var ary = stdout2.split('\n');
                    ary.pop();
                    var latest = ary.pop();
                    argv = ['ln', '-s', latest, 'latest'];
                    common.execFilePlus({
                        argv: argv,
                        cwd: '/usbkey/os',
                        log: self.sdcadm.log
                    }, function (err3, stdout3, stderr3) {
                        if (err3) {
                            return next(err3);
                        }
                        return next();
                    });
                });
            });
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
              'required to manage platforms on a typical SDC setup.',
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
            'must specify platform image UUID or --latest'));
    }

    if (args[0] && args[0] === 'help') {
        return cb(new errors.UsageError(
            'Please, use `sdcadm platform help install` instead'));
    }

    var options = {
        image: (opts.latest) ? 'latest' : args[0]
    };

    if (opts.channel) {
        options.channel = opts.channel;
    }
    self.platform.install(options, cb);
};

PlatformCLI.prototype.do_install.help = (
    'Download and install platform image for later assignment.\n' +
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
        help: 'Update using the last published platform image.'
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

    var platform = args.shift();
    if (platform === 'help') {
        cb(new errors.UsageError(
        'Please, use `sdcadm platform help assign` instead'));
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
            progress: self.progress
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
    'Assign platform image to the given SDC server(s).\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} assign PLATFORM SERVER1 [ SERVER2 [SERVER3] ]\n' +
    '     {{name}} assign PLATFORM --all\n' +
    '\n' +
    '{{options}}'
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
        help: 'Assign given platform image to all servers instead of just ' +
            'the given one(s).'
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
        var rows = platforms.map(function (k) {
            k.boot_platform = k.boot_platform.length;
            k.current_platform = k.current_platform.length;
            return k;
        });
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
    'Provides a list of platform images available to be used.\n' +
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
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'version,current_platform,boot_platform,latest',
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
        'Please, use `sdcadm platform help usage` instead'));
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
                    in_use.join('\n') + '\nPlease, use `--force` option if ' +
                    'you want to remove them anyway';
            }
            return cb(new errors.UsageError(msg));
        }

        return self.platform.remove(opts, cb);
    });
};

PlatformCLI.prototype.do_remove.help = (
    'Removes the given platform image(s).\n' +
    '\n' +
    'When a platform in use by any server is given, the --force option\n' +
    'is mandatory.\n' +
    '\n' +
    'When given, the --all option will remove all the platforms not being\n' +
    'used by any server (neither currently, or configured to boot into).\n' +
    '\n' +
    'Please, note that unless the --cleanup-cache option is given, the \n' +
    'platform image will remain available to be used at the /usbkey/os \n' +
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
        names: ['all'],
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
    }
];


//---- exports

module.exports = {
    PlatformCLI: PlatformCLI
};
