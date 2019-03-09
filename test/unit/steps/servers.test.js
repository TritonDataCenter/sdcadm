/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Test parts of lib/steps/servers.js.
 */

'use strict';

const test = require('tap').test;

const stepsServers = require('../../../lib/steps/servers');


test('steps.servers.ensureServersRunning', function (suite) {
    const ensureServersRunning = stepsServers.ensureServersRunning;

    suite.test('no servers', function (t) {
        ensureServersRunning({servers: []}, function (err) {
            t.ifError(err);
            t.end();
        });
    });

    suite.test('status=running', function (t) {
        ensureServersRunning({
            servers: [
                {
                    uuid: 'fffe64de-41e1-11e9-96ab-c31da21ea778',
                    hostname: 'TESTHOST0',
                    status: 'running'
                },
                {
                    uuid: '0315187a-41e2-11e9-9c21-37ad3dd66f42',
                    hostname: 'TESTHOST1',
                    status: 'running'
                }
            ]
        }, function (err) {
            t.ifError(err);
            t.end();
        });
    });

    suite.test('status=unknown should error', function (t) {
        ensureServersRunning({
            servers: [
                {
                    uuid: 'fffe64de-41e1-11e9-96ab-c31da21ea778',
                    hostname: 'TESTHOST0',
                    status: 'unknown'
                },
                {
                    uuid: '0315187a-41e2-11e9-9c21-37ad3dd66f42',
                    hostname: 'TESTHOST1',
                    status: 'running'
                }
            ]
        }, function (err) {
            t.ok(err, 'expected error that TESTHOST0 is not running');
            t.ok(err.message.includes('not running'),
                'error message includes "not running": ' + err.message);
            t.ok(err.message.includes('TESTHOST0'),
                'error message includes "TESTHOST0": ' + err.message);
            t.end();
        });
    });

    suite.end();
});
