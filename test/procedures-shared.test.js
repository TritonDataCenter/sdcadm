/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2022 Cloudcontainers B.V.
 */

var test = require('tape').test;
var shared = require('../lib/procedures/shared.js');

test('nextIdNoInstances', function (t) {
    var arg = {
        change: {
            service: {
                name: 'portolan'
            }
        },
        instances: []
    };

    arg = shared.getNextInstAliasOrdinal(arg);

    t.equal(arg.nextId, 0);

    t.end();
});

test('nextIdSingleInstance', function (t) {
    var arg = {
        change: {
            service: {
                name: 'portolan'
            }
        },
        instances: [
            {
                params: {
                    alias: 'portolan0'
                }
            }
        ]
    };

    arg = shared.getNextInstAliasOrdinal(arg);

    t.equal(arg.nextId, 1);

    t.end();
});

// Verify instances are sorted numerically instead of as strings
// 10 > 7 while '10' < '7'
// Allows instances to go up to 11 (and beyond)
test('nextIdInstance10', function (t) {
    var arg = {
        change: {
            service: {
                name: 'portolan'
            }
        },
        instances: [
            {
                params: {
                    alias: 'portolan0'
                }
            },
            {
                params: {
                    alias: 'portolan10'
                }
            },
            {
                params: {
                    alias: 'portolan7'
                }
            }
        ]
    };

    arg = shared.getNextInstAliasOrdinal(arg);

    t.equal(arg.nextId, 11);

    t.end();
});
