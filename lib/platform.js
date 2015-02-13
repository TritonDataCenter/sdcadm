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

    if (opts.latest) {
        self.sdcadm._installPlatform({
            image: 'latest',
            progress: self.progress
        }, cb);
    } else if (args[0]) {
        self.sdcadm._installPlatform({
            image: args[0],
            progress: self.progress
        }, cb);
    } else {
        cb(new errors.UsageError(
            'must specify platform image UUID or --latest'));
    }
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
    var server = args;
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
    self.sdcadm._assignPlatform(assignOpts, cb);
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


PlatformCLI.prototype._getPlatformsWithServers =
function _getPlatformsWithServers(cb) {
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

    self._getPlatformsWithServers(function (err, platforms) {
        if (err) {
            return cb(err);
        }

        if (opts.json) {
            console.log(JSON.stringify(platforms, null, 4));
            return cb();
        }
        var rows = [];
        var validFieldsMap = {};

        Object.keys(platforms).forEach(function (k) {
            rows.push({
                version: k,
                boot_platform: platforms[k].boot_platform.length,
                current_platform: platforms[k].current_platform.length,
                latest: platforms[k].latest || false
            });
        });

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
    var platform = args[0];

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

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
        });
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

    var remove = [];
    var changes = [];
    var hist;
    self._getPlatformsWithServers(function (err, platforms) {
        if (err) {
            return cb(err);
        }

        // When --all is given we will not remove anything requiring the
        // --force flag:
        if (opts.all) {
            Object.keys(platforms).forEach(function (k) {
                if (platforms[k].boot_platform.length === 0 &&
                    platforms[k].current_platform.length === 0) {
                    remove.push(k);
                }
            });
        } else {
            args.forEach(function (k) {
                if (platforms[k] &&
                    ((platforms[k].boot_platform.length === 0 &&
                      platforms[k].current_platform.length === 0) ||
                     opts.force)) {
                    remove.push(k);
                }
            });
        }

        if (!remove.length) {
            return cb(new errors.UsageError('No platforms will be removed'));
        }

        vasync.pipeline({funcs: [
            function confirm(_, next) {
                p('');
                p('The following platform images will be removed:');
                p(common.indent(remove.join('\n')));
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
                    platforms: remove
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
                    inputs: remove,
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
                    return next(er3);
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
                    inputs: remove,
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
                    return next(er3);
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
            if (er2) {
                hist.error = er2;
            }
            p('Done.');
            self.sdcadm.history.updateHistory(hist, function (err2) {
                if (err) {
                    return cb(err);
                } else if (err2) {
                    return cb(err2);
                } else {
                    return cb();
                }
            });
        });
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
