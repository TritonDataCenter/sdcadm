/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 *
 * Steps for doing some things with UFDS.
 */

var assert = require('assert-plus');
var UFDS = require('ufds');
var VError = require('verror');


function _createUfdsClient(clientOpts, cb) {
    var client = new UFDS(clientOpts);

    client.once('error', cb);
    client.once('connect', function () {
        client.removeAllListeners('error');
        client.on('error', function (err) {
            clientOpts.log.error(err, 'UFDS disconnected');
        });
        client.on('connect', function () {
            clientOpts.log.info('UFDS reconnected');
        });
        cb(null, client);
    });
}

function _getUfdsClientOpts(ufdsHost, bindDN, bindPassword, log) {
    assert.string(ufdsHost, 'ufdsHost');
    assert.string(bindDN, 'bindDN');
    assert.string(bindPassword, 'bindPassword');
    assert.object(log, 'log');

    return {
        bindDN: bindDN,
        bindPassword: bindPassword,
        log: log,
        url: 'ldaps://' + ufdsHost,
        connectTimeout: 10000,
        retry: {
            maxDelay: 10000,
            retries: 2
        }
    };
}


/*
 * Get a connected client to the local UFDS and set `arg.masterUfdsClient`.
 *
 * The "master" UFDS is determine by the "ufds_*" config vars in the Triton
 * config (i.e. the metadata on the 'sdc' SAPI application). If
 *
 * Callers must clean up by calling `arg.masterUfdsClient.close()` when
 * finished.
 */
function createLocalUfdsClient(arg, cb) {
    assert.object(arg, 'arg');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.config, 'arg.sdcadm.config');
    assert.func(cb, 'cb');

    var clientOpts;
    var config = arg.sdcadm.config;
    var log = arg.log.child({ufds: 'local'}, true);

    if (!config.ufds_ldap_root_pw) {
        cb(new VError('"ufds_ldap_root_pw" config is not set'));
        return;
    }
    clientOpts = _getUfdsClientOpts(
        'ufds.' + config.datacenter_name + '.' + config.dns_domain,
        config.ufds_ldap_root_dn, config.ufds_ldap_root_pw, log);

    _createUfdsClient(clientOpts, function (err, client) {
        arg.localUfdsClient = client;
        cb(err);
    });
}


/*
 * Get a connected client to the "master" UFDS and set `arg.masterUfdsClient`.
 *
 * The "master" UFDS is determine by the "ufds_*" config vars in the Triton
 * config (i.e. the metadata on the 'sdc' SAPI application).
 *
 * Callers must clean up by calling `arg.masterUfdsClient.close()` when
 * finished.
 */
function createMasterUfdsClient(arg, cb) {
    assert.object(arg, 'arg');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.config, 'arg.sdcadm.config');
    assert.func(cb, 'cb');

    var clientOpts;
    var config = arg.sdcadm.config;
    var log = arg.log.child({ufds: 'master'}, true);

    if (config.ufds_is_master) {
        if (!config.ufds_ldap_root_pw) {
            cb(new VError('"ufds_ldap_root_pw" config is not set'));
            return;
        }
        clientOpts = _getUfdsClientOpts(
            'ufds.' + config.datacenter_name + '.' + config.dns_domain,
            config.ufds_ldap_root_dn, config.ufds_ldap_root_pw, log);
    } else {
        if (!config.ufds_remote_ip) {
            cb(new VError(
                '"ufds_remote_ip" config is not set (ufds_is_master=false)'));
            return;
        }
        if (!config.ufds_remote_ldap_root_pw) {
            cb(new VError('"ufds_remote_ldap_root_pw" config is not set '
                + '(ufds_is_master=false)'));
            return;
        }
        clientOpts = _getUfdsClientOpts(config.ufds_remote_ip,
            config.ufds_ldap_root_dn, config.ufds_remote_ldap_root_pw, log);
    }

    _createUfdsClient(clientOpts, function (err, client) {
        arg.masterUfdsClient = client;
        cb(err);
    });
}


// --- exports

module.exports = {
    createLocalUfdsClient: createLocalUfdsClient,
    createMasterUfdsClient: createMasterUfdsClient
};

// vim: set softtabstop=4 shiftwidth=4:
