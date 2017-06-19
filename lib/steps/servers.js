/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 *
 * Steps for doing some things with CNAPI server objects.
 */

var assert = require('assert-plus');
var util = require('util');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');


// ---- internal support functions

function _cnapiServerFromName(args, cb) {
    assert.object(args, 'args');
    assert.object(args.log, 'args.log');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.string(args.serverName, 'args.serverName');
    assert.func(cb, 'cb');

    if (common.UUID_RE.test(args.serverName)) {
        args.sdcadm.cnapi.getServer(args.serverName, function (err, server) {
            if (err) {
                cb(err);
            } else {
                cb(null, server);
            }
        });
    } else {
        args.sdcadm.cnapi.listServers({
            hostname: args.serverName
        }, function (err, servers) {
            if (err) {
                cb(err);
            } else if (servers.length === 0) {
                cb(new errors.UsageError(util.format(
                    'Cannot find server "%s"', args.serverName)));
            } else {
                cb(null, servers[0]);
            }
        });
    }
}


// ---- steps

/**
 * A function appropriate for `vasync.pipeline` funcs that takes a
 * `args.serverName` and sets `args.server` to the CNAPI server object,
 * or errors (via `cb(err)`).
 */
function serversServerFromServerName(args, cb) {
    assert.object(args, 'args');
    assert.object(args.log, 'args.log');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.string(args.serverName, 'args.serverName');
    assert.func(cb, 'cb');

    _cnapiServerFromName(args, function (err, server) {
        if (err) {
            cb(err);
            return;
        }

        args.server = server;
        cb();
    })
}


/**
 * A function appropriate for `vasync.pipeline` funcs that takes a
 * `args.serverNames` and sets `args.servers` to the CNAPI server
 * objects, or errors (via `cb(err)`).
 */
function serversServersFromServerNames(args, cb) {
    assert.object(args, 'args');
    assert.object(args.log, 'args.log');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.arrayOfString(args.serverNames, 'args.serverNames');
    assert.func(cb, 'cb');

    var servers = [];

    // Note: We are assuming the number in parallel here isn't astronomical.
    vasync.forEachParallel({
        inputs: args.serverNames,
        func: function resolveOneServer(serverName, nextServer) {
            _cnapiServerFromName({
                log: args.log,
                sdcadm: args.sdcadm,
                serverName: serverName
            }, function (err, server) {
                if (err) {
                    nextServer(err);
                    return;
                }
                servers.push(server);
                nextServer();
            })
        }
    }, function (err) {
        if (err) {
            cb(err);
            return;
        }
        args.servers = servers;
        cb();
    });
}


/**
 * A function appropriate for `vasync.pipeline` funcs that iterates through
 * `args.servers` and errors if any of them are not setup.
 */
function serversEnsureServersSetup(args, cb) {
    assert.object(args, 'args');
    assert.object(args.log, 'args.log');
    assert.arrayOfObject(args.servers, 'args.servers');
    assert.func(cb, 'cb');

    var unsetup = args.servers.forEach(function (s) {
        return (!s.setup);
    });

    if (unsetup.length) {
        cb(new errors.UsageError(util.format(
            'The following servers are not setup:\n%s\n' +
            unsetup.join(', '))));
    } else {
        cb();
    }
}


/**
 * A function appropriate for `vasync.pipeline` funcs that iterates through
 * `args.servers` and errors if any of them are not running.
 */
function serversEnsureServersRunning(args, cb) {
    assert.object(args, 'args');
    assert.object(args.log, 'args.log');
    assert.arrayOfObject(args.servers, 'args.servers');
    assert.func(cb, 'cb');

    var notRunning = args.servers.forEach(function (s) {
        return (!s.setup);
    });

    if (notRunning.length) {
        cb(new errors.UsageError(util.format(
            'The following servers are not running:\n%s\n' +
            notRunning.join(', '))));
    } else {
        cb();
    }
}


//---- exports

module.exports = {
    serversServerFromServerName: serversServerFromServerName,
    serversServersFromServerNames: serversServersFromServerNames,
    serversEnsureServersSetup: serversEnsureServersSetup,
    serversEnsureServersRunning: serversEnsureServersRunning
};
