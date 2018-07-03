/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Steps for setting the proper "dns_domain" value for SDC application.
 */

var assert = require('assert-plus');

var errors = require('../errors');

function ensureDnsDomainSdcAppParam(arg, cb) {
    assert.object(arg, 'arg');
    assert.func(arg.progress, 'arg.progress');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.sdcApp, 'arg.sdcadm.sdcApp');
    assert.func(cb, 'cb');

    var sdcadm = arg.sdcadm;
    var app = arg.sdcadm.sdcApp;

    if (app.params.dns_domain) {
        cb();
        return;
    }

    arg.progress('Setting "params.dns_domain" on Sdc Application');

    sdcadm.sapi.updateApplication(app.uuid, {
        params: {
            dns_domain: app.metadata.dns_domain
        }
    }, function updateAppCb(sapiErr) {
        if (sapiErr) {
            cb(new errors.SDCClientError(sapiErr, 'sapi'));
            return;
        }
        cb();
    });
}

// --- exports

module.exports = {
    ensureDnsDomainSdcAppParam: ensureDnsDomainSdcAppParam
};

// vim: set softtabstop=4 shiftwidth=4:
