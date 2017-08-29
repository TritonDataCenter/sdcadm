/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 *
 * `sdcadm server headnode-setup ...`
 */

var assert = require('assert-plus');
var path = require('path');
var fs = require('fs');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror');

var common = require('../../common');
var errors = require('../../errors');
var lib_headnode = require('../../headnode');
var steps = require('../../steps');


var format = util.format;


function do_headnode_setup(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length < 1) {
        cb(new errors.UsageError('missing SERVER arg(s)'));
        return;
    }

    var context = {
        log: this.log,
        sdcadm: this.sdcadm,
        progress: this.progress,
        serverNames: args,
        servers: null
    };
    var log = this.log;
    var p = this.progress;

    vasync.pipeline({arg: context, funcs: [
        steps.sapiAssertFullMode,

        steps.serversServersFromServerNames, // ctx.serverNames -> ctx.servers

        function removeServersDupes(ctx, next) {
            var uniqServers = [];
            var uuids = {};
            ctx.servers.forEach(function (server) {
                if (!uuids.hasOwnProperty(server.uuid)) {
                    uuids[server.uuid] = true;
                    uniqServers.push(server);
                }
            });
            ctx.servers = uniqServers;
            next();
        },

        steps.serversHeadnodes,  // ctx.headnodes

        function calcHeadnodeData(ctx, next) {
            ctx.serverFromUuid = {};
            ctx.servers.forEach(function (s) {
                ctx.serverFromUuid[s.uuid] = s;
            });

            ctx.headnodeFromUuid = {};
            ctx.headnodes.forEach(function (s) {
                ctx.headnodeFromUuid[s.uuid] = s;
            });

            log.debug({
                servers: ctx.servers.map(function (s) {
                    return {uuid: s.uuid, hostname: s.hostname}
                })
            }, 'calcHeadnodeData');
            next();
        },

        // TODO: some of the following guard logic could be move to
        // ProcHeadnodeSetup

        /*
         * For now at least we want to abort if any of the given servers are
         * already headnodes.
         */
        function abortIfServersAlreadyHeadnodes(ctx, next) {
            var alreadyHeadnodes = [];
            ctx.servers.forEach(function (s) {
                if (ctx.headnodeFromUuid[s.uuid]) {
                    alreadyHeadnodes.push(s);
                }
            });

            if (alreadyHeadnodes.length > 0) {
                var summaries = alreadyHeadnodes.map(function (s) {
                    return s.uuid + ' (' + s.hostname + ')';
                });
                next(new errors.UsageError(
                    'the following servers are already headnodes: '
                    + summaries.join(', ')));
            } else {
                next();
            }
        },

        /*
         * Confirm intent if moving to >4 headnodes. "4" because the suggested
         * setup is 3 headnodes, plus allowing for one extra for headnode
         * migration and recovery.
         */
        function warnOnTooManyHeadnodes(ctx, next) {
            var numProposedHeadnodes;
            var confirm = false;

            var numProposedHeadnodes = (ctx.headnodes.length
                + ctx.servers.length);
            if (ctx.headnodes.length > 4 || numProposedHeadnodes <= 4) {
                next();
                return;
            }

            p('');
            p('This will result in moving from %d to %d headnodes. It is',
                ctx.headnodes.length, numProposedHeadnodes);
            p('suggested that there are 3 headnodes.');
            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    next(true);
                } else {
                    p('');
                    next();
                }
            });
        },

        /*
         * Currently we don't support setting up an *unsetup* CN directly to
         * an HN.
         *
         * Dev Notes on direct unsetup-CN -> HN setup:
         *  - Get on and ensure it has a usable (pcfs and large enough) USB key?
         *    Q: Need we require that the USB key already has the headnode bits?
         *  - Pass `headnode=true` to the cnapi server setup.
         *      sdcadm server setup --headnode --hostname=HOSTNAME UUID # hn
         *    Then cnapi server update to that workflow to run 'headnode.sh'
         *    (and download it and joysetup.sh). Fix headnode.sh to not do core
         *    zone creation etc. It could take an arg for this.
         *  - TODO: fill this out
         */
        function nyiUnsetupCn(ctx, next) {
            var unsetupServers = ctx.servers.filter(function (s) {
                return (s.setup !== true);
            });
            if (unsetupServers.length > 0) {
                var unsetupServerSummaries = unsetupServers.map(function (s) {
                    return format('server %s (%s) is not setup',
                        s.uuid, s.hostname);
                });
                next(
                    new VError({
                        name: 'NotYetImplemented',
                        info: {
                            unsetupServers: unsetupServers
                        }
                    },
                    'converting an *unsetup* CN to an HN is not yet '
                        + 'implemented:\n    %s',
                    unsetupServerSummaries.join('\n    '))
                );
            } else {
                next();
            }
        },


        /*
         * Confirm a new headnode if there are non-admin zones on it.
         */
        function sanityCheckNonAdminZones(ctx, next) {
            // First, count the non-admin-owned VMs on each new headnode...
            var adminUuid = ctx.sdcadm.config.ufds_admin_uuid;
            var nonAdminVms = [];
            var nonAdminVmsFromServerUuid = {};
            vasync.forEachParallel({
                inputs: ctx.servers,
                func: function vmsForNewHeadnode(server, nextServer) {
                    // XXX Why not have extras=vms from the CNAPI GetServer?
                    ctx.sdcadm.vmapi.listVms({
                        server_uuid: server.uuid
                    }, function (err, vms) {
                        if (err) {
                            nextServer(err);
                            return;
                        }
                        vms.forEach(function (vm) {
                            if (vm.owner_uuid !== adminUuid) {
                                nonAdminVms.push(vm);
                                if (!nonAdminVmsFromServerUuid[server.uuid]) {
                                    nonAdminVmsFromServerUuid[server.uuid] = [];
                                }
                                nonAdminVmsFromServerUuid[server.uuid].push(vm);
                            }
                        });
                        nextServer();
                    });
                }
            }, function (err) {
                if (err) {
                    next(err);
                    return;
                }

                if (nonAdminVms.length === 0) {
                    next();
                    return;
                }

                // ... then if there are any, print which and confirm.
                p('');
                var numServers = Object.keys(nonAdminVmsFromServerUuid).length;
                if (numServers === 1) {
                    p('There are non-admin-owned VMs on the proposed new '
                        + 'headnode:');
                } else {
                    p('There are non-admin-owned VMs on %s of %s of the '
                        + 'proposed new headnodes:', numServers,
                        ctx.servers.length);
                }
                Object.keys(nonAdminVmsFromServerUuid).forEach(function (su) {
                    var vms = nonAdminVmsFromServerUuid[su];
                    var svr = ctx.serverFromUuid[su];
                    p('    server %s (%s): %d VMs', svc.uuid, svc.hostname,
                        vms.length);
                    vms.slice(0, 3).forEach(function (vm) {
                        p('        vm %s (%s)', vm.uuid, vm.alias);
                    });
                    if (vms.length > 3) {
                        p('        ...');
                    }
                });

                XXX // test this
                if (opts.yes) {
                    next();
                    return;
                }
                var msg = 'Would you like to continue? [y/N] ';
                common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                    if (answer !== 'y') {
                        p('Aborting');
                        next(true);
                    } else {
                        p('');
                        next();
                    }
                });
            });
        },

        function sanityCheckMinVersions(ctx, next) {
            self.progress('XXX sanityCheckMinVersions');
            next();
        },

        // TODO: ensure target server(s) have a USB key that can be used
        //*  - Ensure there is a USB key to use: a la usbkey.js, look for a pcfs
        //*    device in `diskinfo`. *Typically* has TYPE=USB, but not so in coal for
        //*    example.
        //*    We can't use `sdc-usbkey` on unsetup CNs.

        // TODO: eventually check a new headnode has reasonable resources for
        // future recovery

        // TODO: if there is an HA manatee on one of the CNs being converted,
        // then ensure manatee-adm pg-status shows 3 happy peers. If not,
        // error out.

        function getProcAndConfirm(ctx, next) {
            ctx.proc = new lib_headnode.ProcHeadnodeSetup({
                servers: ctx.servers
            });

            p('');
            p('This headnode-setup will make the following changes:');
            p(common.indent(ctx.proc.summarize()));
            p('');

            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    next(true);
                } else {
                    p('');
                    next();
                }
            });
        },

        function execProc(ctx, next) {
            ctx.proc.execute({
                sdcadm: ctx.sdcadm,
                progress: ctx.progress,
                log: ctx.log
            }, next);
        },

        function done(_, next) {
            self.progress('XXX done do_headnode_setup');
            next();
        }
    ]}, function finishUp(err) {
        if (err === true) {
            // Early abort signal.
            err = null;
        }
        cb(err);
    });
}

do_headnode_setup.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    }
];
do_headnode_setup.help = [
    'Prepare server(s) to act as a headnode for the DC.',
    '',
    'A Triton DC can be setup with multiple servers (3 are recommended) acting',
    'as "headnodes". Multiple headnodes and redundant instances of specific',
    'core Triton services allows for resiliency from headnode failure. One',
    'headnode acts as the primary and the others as secondaries.',
    // XXX no primary, update language
    '',
    'This command supports (a) preparing an older headnode for multiple ',
    'headnodes and (b) converting a compute node to a secondary headnode.',
    'Commands under "sdcadm headnode" support recovering from a failed primary',
    'headnode and getting a secondary headnode to take over services from',
    'another headnode to allow end-of-lifing headnode hardware.',
    '',
    'Usage:',
    '     {{name}} {{cmd}} SERVERS...',
    '',
    '{{options}}',
    ''
].join('\n');


// --- exports

module.exports = do_headnode_setup;
