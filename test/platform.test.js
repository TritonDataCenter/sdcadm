/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


var test = require('tape').test;
var vasync = require('vasync');

var exec = require('child_process').exec;
var util = require('util');

var common = require('./common');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var ISO_DATE_RE = /\d{4}[01]\d[0-3]\dT[0-2]\d[0-5]\d[0-5]\dZ/;

var LIST_TITLES = [
    'VERSION', 'CURRENT_PLATFORM', 'BOOT_PLATFORM', 'LATEST', 'DEFAULT'
];
var AVAIL_TITLES = [
    'VERSION', 'UUID', 'PUBLISHED_AT'
];
var USAGE_TITLES = [
    'UUID', 'HOSTNAME', 'CURRENT_PLATFORM', 'BOOT_PLATFORM'
];
var CNAPI_PLATFORMS;
var CNAPI_SERVERS;

var LATEST_PLATFORM;

var LATEST_AVAIL_PLATFORM;
var AVAIL_PLATFORMS = [];

var INSTALLED_PLATFORMS = [];

test('setup', function (t) {
    var cmd = 'sdc-cnapi /platforms | json -H';
    exec(cmd, function (err2, stdout2, stderr2) {
        t.ifError(err2);

        var platformsInfo = common.parseJsonOut(stdout2);
        if (!platformsInfo) {
            t.ok(false, 'failed to parse /platforms JSON');
            return t.end();
        }

        CNAPI_PLATFORMS = platformsInfo;

        var cmd2 = 'sdc-cnapi /servers | json -H';
        exec(cmd2, function (err3, stdout3, stderr3) {
            t.ifError(err3);

            var servers = common.parseJsonOut(stdout3);
            if (!servers) {
                t.ok(false, 'failed to parse /servers JSON');
                return t.end();
            }

            CNAPI_SERVERS = servers;

            t.end();
        });
    });
});

test('sdcadm platform --help', function (t) {
    exec('sdcadm platform --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm platform [OPTIONS] COMMAND') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm platform list', function (t) {
    exec('sdcadm platform list', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var platformsDetails = common.parseTextOut(stdout);

        var titles = platformsDetails.shift();
        t.deepEqual(titles, LIST_TITLES, 'check column titles');

        platformsDetails = platformsDetails.map(function (r) {
            var timestamp = r[0];
            var numCurrPlatform = +r[1];
            var numBootPlatform = +r[2];
            var latest = r[3];

            t.ok(timestamp.match(ISO_DATE_RE), 'platform has timestamp');
            t.ok(!isNaN(numCurrPlatform), 'current_platform count is a number');
            t.ok(!isNaN(numBootPlatform), 'boot_platform count is a number');
            t.ok(latest === 'true' || latest === 'false', 'latest is boolean');

            latest = latest === 'true';

            return {
                timestamp: timestamp,
                num_curr_platform: numCurrPlatform,
                num_boot_platform: numBootPlatform,
                latest: latest
            };
        });


        var platformNames = Object.keys(CNAPI_PLATFORMS);

        t.equal(platformNames.length, platformsDetails.length,
                'platform counts');

        platformsDetails.forEach(function (platform) {
            t.equal(platform.latest,
                    (CNAPI_PLATFORMS[platform.timestamp].latest === true),
                    'latest for platform ' + platform.timestamp);
            var timestamp = platform.timestamp;

            var timestampPlatforms = CNAPI_SERVERS.filter(function (server) {
                return server.current_platform === timestamp;
            });

            t.equal(timestampPlatforms.length, platform.num_curr_platform);
        });

        t.end();

    });
});


test('sdcadm platform list --json', function (t) {
    exec('sdcadm platform list --json', function (err, stdout, stderr) {
        if (err) {
            t.ifError(err, 'Execution error');
            t.end();
            return;
        }
        t.equal(stderr, '');

        var platforms = common.parseJsonOut(stdout);
        t.ok(platforms.length >= 1);
        platforms.forEach(function (p) {
            t.ok(p.version, 'platform version');
            t.ok(p.boot_platform, 'boot_platform');
            t.ok(p.current_platform, 'current_platform');
            t.ok(typeof (p.latest) === 'boolean', 'platform latest');
            t.ok(typeof (p.default) === 'boolean', 'platform default');
            t.ok(typeof (p.usb_key) === 'boolean', 'platform usb_key');
            if (p.latest) {
                LATEST_PLATFORM = p;
            }
        });

        t.end();
    });
});


test('sdcadm platform avail -j', function (t) {
    exec('sdcadm platform avail -j', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var platforms = common.parseJsonOut(stdout);

        platforms.forEach(function (p) {
            t.ok(p.version, 'available platform version');
            t.ok(p.uuid, 'available platform uuid');
            t.ok(p.published_at, 'available platform published_at');
        });

        if (platforms.length) {
            LATEST_AVAIL_PLATFORM = platforms.pop();
            AVAIL_PLATFORMS = platforms;
        }

        t.end();
    });
});


test('sdcadm platform available', function (t) {
    exec('sdcadm platform available', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var platformsDetails = common.parseTextOut(stdout);

        var titles = platformsDetails.shift();
        t.deepEqual(titles, AVAIL_TITLES, 'check column titles');

        platformsDetails.forEach(function (p) {
            t.ok(p[0].match(ISO_DATE_RE), 'platform has timestamp');
            t.notOk(CNAPI_PLATFORMS[p[0]], 'platform not installed');
        });

        t.end();
    });
});


test('sdcadm platform usage', function (t) {
    exec('sdcadm platform usage', function (err, stdout, stderr) {
        t.ok(err, 'usage error');
        t.notEqual(stderr.indexOf('platform name is required'), -1);

        t.end();
    });
});


test('sdcadm platform usage VERSION', function (t) {
    var cmd = util.format('sdcadm platform usage %s', LATEST_PLATFORM.version);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var usageDetails = common.parseTextOut(stdout);
        if (!usageDetails || !usageDetails.length) {
            // If latest platform is not used at all, we will not have any
            // output so cannot check titles:
            t.comment('Skipping usage checks (latest platform not used)');
            t.end();
            return;
        }

        var titles = usageDetails.shift();
        t.deepEqual(titles, USAGE_TITLES, 'check column titles');
        usageDetails.forEach(function (d) {
            t.ok(d[0].match(UUID_RE), 'server uuid');
            t.ok(d[2].match(ISO_DATE_RE), 'current_platform has timestamp');
            t.ok(d[3].match(ISO_DATE_RE), 'boot_platform has timestamp');
        });
        t.end();
    });
});


test('sdcadm platform usage VERSION -j', function (t) {
    var cmd = util.format('sdcadm platform usage %s -j',
            LATEST_PLATFORM.version);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var usageDetails = common.parseJsonOut(stdout);
        usageDetails.forEach(function (d) {
            USAGE_TITLES.map(function (title) {
                return title.toLowerCase();
            }).forEach(function (prop) {
                t.ok(d[prop], 'usage has property ' + prop);
            });
        });
        t.end();
    });
});


test('sdcadm platform install', function (t) {
    exec('sdcadm platform install', function (err, stdout, stderr) {
        t.ok(err, 'Execution error');
        t.notEqual(stderr.indexOf(
                    'must specify Platform Image UUID or --latest'), -1);

        t.end();
    });
});


test('sdcadm platform install --latest', function (t) {
    if (!LATEST_AVAIL_PLATFORM) {
        t.end();
        return;
    }
    exec('sdcadm platform install --latest', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        // Progress bar
        t.notEqual(stderr, '', 'Empty stderr');
        t.notEqual(stdout.indexOf(
                    'Platform installer finished successfully'), -1);

        INSTALLED_PLATFORMS.push(LATEST_AVAIL_PLATFORM);
        t.end();
    });
});


test('sdcadm platform install UUID', function (t) {
    if (AVAIL_PLATFORMS.length === 0) {
        t.end();
        return;
    }
    var cmd = util.format('sdcadm platform install %s',
            AVAIL_PLATFORMS[0].uuid);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        // Progress bar
        t.notEqual(stderr, '', 'Empty stderr');

        t.notEqual(stdout.indexOf(
                    'Platform installer finished successfully'), -1);
        INSTALLED_PLATFORMS.push(AVAIL_PLATFORMS[0]);
        t.end();
    });
});


test('sdcadm platform assign', function (t) {
    if (!LATEST_AVAIL_PLATFORM) {
        t.end();
        return;
    }
    var _1stServer = CNAPI_SERVERS[0];
    var currPlatform = _1stServer.boot_platform;
    var cmd = util.format('sdcadm platform assign %s %s',
            LATEST_AVAIL_PLATFORM.version, _1stServer.uuid);
    var cnapiCmd = util.format('sdc-cnapi /servers/%s|json -H',
                    _1stServer.uuid);


    vasync.pipeline({
        funcs: [
            function assignPlatform(_, next) {
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');

                    t.notEqual(stdout.indexOf('updating ' +
                        _1stServer.hostname +
                        ' ' + _1stServer.uuid + ' to ' +
                        LATEST_AVAIL_PLATFORM.version), -1);
                    next();
                });
            },
            function checkCnapiPlatform(_, next) {
                exec(cnapiCmd, function (err2, stdout2, stderr2) {
                    t.ifError(err2, 'CNAPI error');
                    t.equal(stderr2, '', 'Empty stderr');

                    var server = common.parseJsonOut(stdout2);
                    t.equal(server.boot_platform,
                            LATEST_AVAIL_PLATFORM.version,
                            'Platform assigned');
                    next();
                });
            },
            function reassignPlatform(_, next) {
                var cmd2 = util.format('sdcadm platform assign %s %s',
                    currPlatform, _1stServer.uuid);
                exec(cmd2, function (err3, stdout3, stderr3) {
                    t.ifError(err3, 'Execution error');
                    t.equal(stderr3, '', 'Empty stderr');


                    t.notEqual(stdout3.indexOf('updating ' +
                                _1stServer.hostname +
                                ' ' + _1stServer.uuid + ' to ' +
                                currPlatform), -1);
                    next();
                });
            },
            function reCheckCnapiPlatform(_, next) {
                exec(cnapiCmd, function (err4, stdout4, stderr4) {
                    t.ifError(err4, 'Execution error');
                    t.equal(stderr4, '', 'Empty stderr');

                    var server = common.parseJsonOut(stdout4);
                    t.equal(server.boot_platform, currPlatform,
                            'Platform assigned');
                    next();
                });
            }
        ]
    }, function (pipeErr) {
        t.end();
    });

});

// Run twice, set it back to whatever the value it has before
test('sdcadm platform set-default', function (t) {
    if (!LATEST_AVAIL_PLATFORM) {
        t.end();
        return;
    }

    vasync.pipeline({
        arg: {
            cnapiCmd: 'sdc-cnapi /boot/default|json -H',
            bootParams: null,
            currPlatform: null
        },
        funcs: [
            function getBootParams(ctx, next) {
                exec(ctx.cnapiCmd, function (err, stdout, stderr) {
                    t.ifError(err, 'CNAPI error');
                    t.equal(stderr, '', 'Empty stderr');

                    ctx.currPlatform = common.parseJsonOut(stdout).platform;
                    next();
                });
            },
            function changeBootParams(ctx, next) {
                var cmd = 'sdcadm platform set-default ' +
                    LATEST_AVAIL_PLATFORM.version;
                exec(cmd, function (err2, stdout2, stderr2) {
                    t.ifError(err2, 'Execution error');
                    t.equal(stderr2, '', 'Empty stderr');

                    t.notEqual(stdout2.indexOf('Successfully set default ' +
                                'platform to ' +
                                LATEST_AVAIL_PLATFORM.version), -1);
                    next();
                });
            },
            function getUpdatedBootParams(ctx, next) {
                exec(ctx.cnapiCmd, function (err3, stdout3, stderr3) {
                    t.ifError(err3, 'Execution error');
                    t.equal(stderr3, '', 'Empty stderr');

                    ctx.bootParams = common.parseJsonOut(stdout3);
                    t.equal(ctx.bootParams.platform,
                            LATEST_AVAIL_PLATFORM.version,
                            'Set default platform');
                    next();
                });
            },
            function rollbackBootParams(ctx, next) {
                var cmd = 'sdcadm platform set-default ' + ctx.currPlatform;

                exec(cmd, function (err4, stdout4, stderr4) {
                    t.ifError(err4, 'Execution error');
                    t.equal(stderr4, '', 'Empty stderr');

                    t.notEqual(stdout4.indexOf(
                                'Successfully set default platform to ' +
                                ctx.currPlatform), -1);
                    next();

                });
            },
            function verifyRolledBackBootParams(ctx, next) {
                exec(ctx.cnapiCmd, function (err5, stdout5, stderr5) {
                    t.ifError(err5, 'Execution error');
                    t.equal(stderr5, '', 'Empty stderr');

                    ctx.bootParams = common.parseJsonOut(stdout5);
                    t.equal(ctx.bootParams.platform, ctx.currPlatform,
                        'Reset default platform');
                    next();
                });
            }
        ]
    }, function (pipeErr) {
        t.end();
    });

});


// Remove only if we installed something:
test('sdcadm platform remove', function (t) {
    if (INSTALLED_PLATFORMS.length === 0) {
        t.end();
        return;
    }
    vasync.forEachPipeline({
        inputs: INSTALLED_PLATFORMS,
        func: function (platform, next) {
            var command = util.format(
                    'sdcadm platform remove %s --cleanup-cache -y',
                    platform.version);
            exec(command, function (err, stdout, stderr) {
                t.ifError(err, 'Execution error');
                t.equal(stderr, '', 'Empty stderr');
                t.notEqual(stdout.indexOf(
                    'Removing platform ' + platform.version), -1);

                next();
            });
        }
    }, function (_, results) {
        t.end();
    });
});
