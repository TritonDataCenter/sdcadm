/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The collection of "step" functions. Re-usable chunks of sdcadm code.
 * See the "README.md".
 */
'use strict';

// --- exports

module.exports = {
    binder: require('./binder'),
    dnsdomain: require('./dnsdomain'),
    images: require('./images'),
    noRabbit: require('./noRabbit'),
    sapi: require('./sapi'),
    servers: require('./servers'),
    updateVmSize: require('./updateVmSize'),
    usbkey: require('./usbkey'),
    zookeeper: require('./zookeeper')
};

// vim: set softtabstop=4 shiftwidth=4:
