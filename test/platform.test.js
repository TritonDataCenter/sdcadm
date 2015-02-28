/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;
var common = require('./common');


var LIST_TITLES = ['VERSION', 'CURRENT_PLATFORM', 'BOOT_PLATFORM', 'LATEST'];


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
        t.deepEqual(titles, LIST_TITLES);

        platformsDetails = platformsDetails.map(function (r) {
            var timestamp = r[0];
            var numCurrPlatform = +r[1];
            var numBootPlatform = +r[2];
            var latest = r[3];

            t.ok(timestamp.match(/^201\d+T\d+Z$/), 'platform has timestamp');
            t.ok(!isNaN(numCurrPlatform), 'current_platform count is a number');
            t.ok(!isNaN(numBootPlatform), 'boot_platform count is a number');
            t.ok(latest === 'true' || latest === 'false', 'latest is boolean');

            latest = latest === 'true';

            return {
                timestamp: timestamp,
                curr_platform: numCurrPlatform,
                boot_platform: numBootPlatform,
                latest: latest
            };
        });

        var cmd = 'sdc-cnapi /platforms | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);

            var platformsInfo = common.parseJsonOut(stdout2);
            if (!platformsInfo) {
                t.ok(false, 'failed to parse /platforms JSON');
                return t.end();
            }

            var platformNames = Object.keys(platformsInfo);

            t.equal(platformNames.length, platformsDetails.length,
                    'platform counts');

            platformsDetails.forEach(function (platform) {
                t.equal(platform.latest,
                        platformsInfo[platform.timestamp].latest,
                        'latest for platform ' + platform.timestamp);
            });

            var cmd2 = 'sdc-cnapi /servers | json -H';
            exec(cmd2, function (err3, stdout3, stderr3) {
                t.ifError(err3);

                var servers = common.parseJsonOut(stdout3);
                if (!servers) {
                    t.ok(false, 'failed to parse /servers JSON');
                    return t.end();
                }

                platformsDetails.forEach(function (platform) {
                    var timestamp = platform.timestamp;

                    var timestampPlatforms = servers.filter(function (server) {
                        return server.current_platform === timestamp;
                    });

                    t.equal(timestampPlatforms.length, platform.curr_platform);
                });

                t.end();
            });
        });
    });
});
