/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
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
    assert.optionalArrayOfString(args.serverExtras, 'args.serverExtras');
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
        var listOpts = {hostname: args.serverName};
        if (args.serverExtras) {
            listOpts.extras = args.serverExtras.join(',');
        }

        args.sdcadm.cnapi.listServers(listOpts, function (err, servers) {
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
function serverFromServerName(args, cb) {
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
    });
}


/**
 * A function appropriate for `vasync.pipeline` funcs that takes a
 * `args.serverNames` and sets `args.servers` to the CNAPI server
 * objects, or errors (via `cb(err)`).
 */
function serversFromServerNames(args, cb) {
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
            });
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
function ensureServersSetup(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfObject(args.servers, 'args.servers');
    assert.func(cb, 'cb');

    var unsetup = args.servers
        .filter(function (s) { return (!s.setup); })
        .map(function (s) {
            return util.format('%s (%s)', s.uuid, s.hostname);
        });

    if (unsetup.length) {
        cb(new errors.UsageError(util.format(
            'The following servers are not setup:\n    %s',
            unsetup.join('\n    '))));
    } else {
        cb();
    }
}


/**
 * A function appropriate for `vasync.pipeline` funcs that iterates through
 * `args.servers` and errors if any of them are not running.
 */
function ensureServersRunning(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfObject(args.servers, 'args.servers');
    assert.func(cb, 'cb');

    var notRunning = args.servers
        .filter(function (s) {
            return (s.status !== 'running');
        })
        .map(function (s) {
            return util.format('%s (%s)', s.uuid, s.hostname);
        });

    if (notRunning.length) {
        cb(new errors.UsageError(util.format(
            'The following servers are not running:\n    %s',
            notRunning.join('\n    '))));
    } else {
        cb();
    }
}


/**
 * Select a set of servers and return an array of the selected CNAPI server
 * objects.
 *
 * Dev Note: This isn't in the "step" form where it sets its response on
 * the given `args` object. Because it takes so many (optional) arguments,
 * I feel that is messy. Granted it is also slightly messy to have a non-step
 * export in "lib/steps/$name.js".
 *
 * If called without arguments, this will return all running and setup
 * servers in CNAPI (i.e. in the datacenter). The optional args can be used
 * to tweak that. If after `includeServerNames` and `excludeServerNames`
 * are used to determine a server set, it is an error if any of those
 * servers are not setup (unless `allowNotSetup=true`) or not running (unless
 * `allowNotRunning`).
 *
 * @param {Bunyan Logger} args.log: Required.
 * @param {SdcAdm} args.sdcadm: Required.
 * @param {Array} args.includeServerNames: An array of server names (UUID or
 *      hostname) to include in the results. Commonly this is associated with
 *      a `-s=NAMES, --servers=NAMES` CLI option.
 * @param {Array} args.excludeServerNames: An array of server names (UUID or
 *      hostname) to exclude from the results. Commonly this is associated with
 *      a `-S=NAMES, --exclude-servers=NAMES` CLI option.
 * @param {Boolean} args.allowNotSetup: If true, allow inclusion of servers
 *      that are not yet setup.
 * @param {Boolean} args.allowNotRunning: If true, allow inclusion of servers
 *      that are not running.
 * @param {Boolean} args.allowEmpty: If true, allow the resulting set of
 *      servers to be empty. If false or not given, it is an error if no
 *      servers meet the criteria.
 * @param {Array} args.serverExtras: Strings to pass to any CNAPI ServerList
 *      calls as the 'extras' param to ensure those fields are included on the
 *      returned server objects.
 * @param {Function} cb: `function (err)`. Required. If successful,
 *      `args.servers` is set an array of CNAPI server objects for the
 *      selected servers.
 */
function selectServers(args, cb) {
    assert.object(args, 'args');
    assert.object(args.log, 'args.log');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.optionalArrayOfString(args.includeServerNames,
        'args.includeServerNames');
    assert.optionalArrayOfString(args.excludeServerNames,
        'args.excludeServerNames');
    assert.optionalBool(args.allowNotSetup, 'args.allowNotSetup');
    assert.optionalBool(args.allowNotRunning, 'args.allowNotRunning');
    assert.optionalBool(args.allowEmpty, 'args.allowEmpty');
    assert.optionalArrayOfString(args.serverExtras, 'args.serverExtras');
    assert.func(cb, 'cb');

    var servers;

    vasync.pipeline({funcs: [
        // If no includeServerNames, then list all servers (per setup and
        // running settings).
        function getAllServersIfNecessary(_, next) {
            if (args.includeServerNames) {
                next();
                return;
            }

            var listOpts = {};
            if (args.serverExtras) {
                listOpts.extras = args.serverExtras.join(',');
            }
            if (!args.allowNotSetup) {
                listOpts.setup = true;
            }
            args.sdcadm.cnapi.listServers(listOpts, function (err, svrs, res) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }

                if (!args.allowNotRunning) {
                    svrs = svrs.filter(
                        function oneS(s) { return s.status === 'running'; });
                }

                servers = svrs;
                next();
            });
        },

        // Otherwise, GetServer for each included server name.
        function resolveIncludedServerNames(_, next) {
            if (!args.includeServerNames) {
                next();
                return;
            }

            servers = [];

            // Note: We are assuming the number in parallel here isn't huge.
            vasync.forEachParallel({
                inputs: args.includeServerNames,
                func: function resolveOneServer(serverName, nextServer) {
                    _cnapiServerFromName({
                        log: args.log,
                        sdcadm: args.sdcadm,
                        serverName: serverName,
                        serverExtras: args.serverExtras
                    }, function (err, server) {
                        if (server) {
                            servers.push(server);
                        }
                        nextServer(err);
                    });
                }
            }, function (err) {
                next(err);
            });
        },

        function filterOutExcludeServerNames(_, next) {
            if (!args.excludeServerNames) {
                next();
                return;
            }

            var names = {};
            for (let name of args.excludeServerNames) {
                names[name] = true;
            }

            var filteredServers = [];
            for (let server of servers) {
                if (!names[server.uuid] && !names[server.hostname]) {
                    filteredServers.push(server);
                }
            }

            servers = filteredServers;
            next();
        },

        // Check setup and running status per allowNotRunning & allowNotSetup
        function checkSetupIfNecessary(_, next) {
            if (args.allowNotSetup) {
                next();
            } else {
                ensureServersSetup({servers: servers}, next);
            }
        },
        function checkRunningIfNecessary(_, next) {
            if (args.allowNotRunning) {
                next();
            } else {
                ensureServersRunning({servers: servers}, next);
            }
        },

        // Check not empty.
        function checkNotEmptyIfNecessary(_, next) {
            if (args.allowEmpty || servers.length > 0) {
                next();
            } else {
                var details = [];
                if (!args.allowNotSetup) {
                    details.push('setup');
                }
                if (!args.allowNotRunning) {
                    details.push('running');
                }
                if (args.includeServerNames) {
                    details.push('including ' +
                        args.includeServerNames.join(','));
                }
                if (args.excludeServerNames) {
                    details.push('excluding ' +
                        args.excludeServerNames.join(','));
                }
                next(new errors.UsageError(
                    'No servers matching criteria were found: ' +
                    details.join('; ')));
            }
        }
    ]}, function finish(err) {
        cb(err, servers);
    });
}


// --- exports

module.exports = {
    serverFromServerName: serverFromServerName,
    serversFromServerNames: serversFromServerNames,
    ensureServersSetup: ensureServersSetup,
    ensureServersRunning: ensureServersRunning,
    selectServers: selectServers
};

// vim: set softtabstop=4 shiftwidth=4:
