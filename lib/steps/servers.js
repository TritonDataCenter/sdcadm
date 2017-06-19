/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */
var util = require('util');
var format = util.format;

var assert = require('assert-plus');

var errors = require('../errors');

/*
 * Given a list of server hostnames or UUIDs return their respective
 * server records.
 *
 * - `opts` is an object which should contain a `sdcadm` instance and the
 *      `serverNames` of the found servers.
 * - `cb` must be a function with the arguments
 *      `f(err, serversFound, serverByUuidOrHostname)`
 */
function getServersByUuidOrHostname(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.optionalObject(opts.query, 'opts.query');
    assert.arrayOfString(opts.serverNames, 'opts.serverNames');
    assert.func(cb, 'cb');

    var sdcadm =  opts.sdcadm;
    var query = opts.query || {};
    var serverFromUuidOrHostname = {};
    var serversFound;


    sdcadm.cnapi.listServers(query, function (err, servers) {
        if (err) {
            cb(err);
            return;
        }
        var i;
        for (i = 0; i < servers.length; i++) {
            serverFromUuidOrHostname[servers[i].uuid] = servers[i];
            serverFromUuidOrHostname[servers[i].hostname] = servers[i];
        }

        serversFound = opts.serverNames.map(function (s) {
            return serverFromUuidOrHostname[s];
        }).filter(function (x) {
            return x !== undefined && x !== null;
        });

        var unsetup = [];
        serversFound.forEach(function (s) {
            if (!s.setup) {
                unsetup.push(s.uuid);
            }
        });

        if (unsetup.length) {
            cb(new errors.UsageError(format(
                'The following servers are not setup:\n%s\n' +
                'Please make sure to setup these servers ' +
                'or remove them from the list of servers.',
                unsetup.join(', '))));
            return;
        }


        var notRunning = [];
        serversFound.forEach(function (srv) {
            if (srv.status !== 'running' ||
                (srv.status === 'running' && srv.transitional_status !== '')) {
                notRunning.push(srv.uuid);
            }
        });

        if (notRunning.length) {
            cb(new errors.UsageError(format(
                'The following servers are not running:\n%s\n' +
                'Please make sure of these servers are running ' +
                'or remove them from the list of servers.',
                notRunning.join(', '))));
            return;
        }

        cb(null, serversFound, serverFromUuidOrHostname);
    });
}

//---- exports

module.exports = {
    getServersByUuidOrHostname: getServersByUuidOrHostname
};

// vim: set softtabstop=4 shiftwidth=4:
