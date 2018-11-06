/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Collection of 'sdcadm check ...' CLI commands.
 *
 * Initially just `sdcadm check server-agents` command, but both
 * `sdcadm check sapi-services` and `sdcadm check sapi-instances`
 * are also expected in the short term.
 */

const p = console.log;
const fs = require('fs');
const util = require('util');

const assert = require('assert-plus');
const cmdln = require('cmdln');
const Cmdln = cmdln.Cmdln;
const tabula = require('tabula');
const vasync = require('vasync');

const common = require('./common');
const errors = require('./errors');

function Check(top) {
    this.top = top;
    this.sdcadm = top.sdcadm;
    this.progress = top.progress;
    this.log = top.log;
}

/*
 * Verify that the current agent instances installed into one or more
 * Triton servers match with the "desired" versions and eventually, perform
 * the required operations to fix the existing discordances.
 *
 * In general, "desired" agent version will be given by the `image_uuid`
 * attribute of the SAPI service for a given Triton Agent. It's possible that
 * for a given server, that `image_uuid` could have been set to something
 * else and, on such case, the "desired" image will be considered the value
 * set to that server's agent instance in SAPI.
 *
 *
 * Note that if some of the given servers are not available, those will be
 * ignored but for a warning message printed to stdout.
 */
Check.prototype.checkServerAgents = function checkServerAgents(opts, cb) {
    const self = this;

    assert.func(cb, 'cb');
    assert.object(opts, 'opts');
    assert.optionalArrayOfString(opts.servers, 'opts.servers');
    assert.optionalArrayOfString(opts.svcs, 'opts.svcs');

    let isWantedSvc;
    if (opts.svcs) {
        isWantedSvc = {};
        for (let j = 0; j < opts.svcs.length; j++) {
            isWantedSvc[opts.svcs[j]] = true;
        }
    }

    let context = {};

    vasync.pipeline({ arg: context, funcs: [
        /*
         * Sets `ctx.svcFromName`, an Object with service names as
         * keys and their respective SAPI service instances as values.
         * (It would be better to use a Map instead of an Object, but
         * would require `vasync.forEachParallel` changes since it's using
         * `Array.isArray` to validate `inputs`).
         *
         * Note that only desired services will be included. It's to say,
         * if no `opts.svcs` is present, all agent services will be present,
         * otherwise only the given ones will do.
         *
         * Additionally it will check if the SAPI service lacks of the required
         * `params.image_uuid` value and, if that's the case, it will ask to
         * properly fix that during a forthcoming step. To this matter the
         * variable `ctx.svcsToCheck` will be set to an array containing the
         * services with this deffect.
         */
        function getServices(ctx, next) {
            self.sdcadm.getServices({}, function (err, svcs) {
                if (err) {
                    next(err);
                    return;
                }

                ctx.svcs = svcs;
                ctx.svcFromName = {};
                ctx.svcsToCheck = [];
                for (let i = 0; i < svcs.length; i++) {
                    let svc = svcs[i];
                    if (svc.type === 'agent') {
                        if (!opts.svcs ||
                            (isWantedSvc && isWantedSvc[svc.name])) {
                            if (svc.name !== 'provisioner' &&
                                svc.name !== 'heartbeater' &&
                                svc.name !== 'zonetracker') {
                                ctx.svcFromName[svc.name] = svc;
                            }

                            if (svc.params && !svc.params.image_uuid &&
                                    svc.name !== 'dockerlogger') {
                                ctx.svcsToCheck.push(svc);
                            }
                        }
                    }
                }
                next();
            });
        },

        function confirmAgentServiceUpdates(ctx, next) {
            if (!ctx.svcsToCheck.length) {
                next();
                return;
            }
            p('');
            p('There are agent services with missing image_uuid values.');
            p('In order to continue, services must be fixed.');
            p('');
            if (opts.yes) {
                next();
                return;
            }
            common.promptYesNo({
                msg: 'Would you like to continue? [y/N] ',
                default: 'n'
            }, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    cb();
                    return;
                }
                p('');
                next();
            });
        },

        function updateAgentsImages(ctx, next) {
            if (!ctx.svcsToCheck.length) {
                next();
                return;
            }

            function updateAgentImage(agent, callback) {
                vasync.pipeline({
                    funcs: [
                        function readAgentImg(_, _cb) {
                            const name = agent.name;
                            const imgUUIDPath = util.format(
                                '/opt/smartdc/agents/lib/' +
                                'node_modules/%s/image_uuid',
                                name);
                            fs.readFile(imgUUIDPath, {
                                encoding: 'utf8'
                            }, function (err, data) {
                                if (err) {
                                    self.sdcadm.log.error({err: err},
                                        'Error reading agent image uuid');
                                    _cb(err);
                                    return;
                                }
                                agent.params.image_uuid = data.trim();
                                _cb();
                            });

                        },
                        function updateAgentImg(_, nextAgent) {
                            self.progress('Updating service for agent \'%s\'',
                                    agent.name);
                            self.sdcadm.sapi.updateService(agent.uuid, {
                                params: agent.params
                            }, function (err, _svc) {
                                if (err) {
                                    nextAgent(new errors.SDCClientError(
                                        err, 'sapi'));
                                    return;
                                }
                                nextAgent();
                            });
                        }
                    ]
                }, function paraCb(paraErr) {
                    delete ctx.svcsToCheck;
                    callback(paraErr);
                });
            }

            vasync.forEachParallel({
                inputs: ctx.svcsToCheck,
                func: updateAgentImage
            }, next);
        },

        /*
         * Sets `ctx.serverFromUuidOrHostname`, an object collecting all the
         * CNAPI servers using both, `UUID` and `hostname` as as object keys.
         *
         * While this isn't very performant right now, it's the only way we
         * have currently to support `hostname` as a server argument instead of
         * `UUID`.
         *
         * Additionally, if no `opts.servers` is given, the variable
         * `ctx.allServers` will be also set to an array of all the servers
         * UUIDs, which will be used later to report lack of availability for
         * those servers not running.
         */
        function getServers(ctx, next) {
            self.sdcadm.cnapi.listServers({
                extras: 'sysinfo,agents'
            }, function (err, servers) {
                servers = servers || [];
                ctx.serverFromUuidOrHostname = {};
                ctx.allServers = [];
                for (var i = 0; i < servers.length; i++) {
                    ctx.serverFromUuidOrHostname[servers[i].uuid] = servers[i];
                    ctx.serverFromUuidOrHostname[servers[i].hostname] =
                        servers[i];
                    // We'll use this later to check availability:
                    if (!opts.servers) {
                        ctx.allServers.push(servers[i].uuid);
                    }
                }
                next(err);
            });
        },

        function validateServers(ctx, next) {
            // Make sure we get a list of uuids even if hostnames may be
            // initially present as servers option:
            if (opts.servers && opts.servers.length) {
                var notFound = opts.servers.filter(function (s) {
                    return (!ctx.serverFromUuidOrHostname[s]);
                });
                if (notFound.length) {
                    next(new errors.UsageError(util.format(
                            'unknown servers "%s"', notFound.join('", "'))));
                    return;
                }
                opts.servers = opts.servers.map(function (s) {
                    return ctx.serverFromUuidOrHostname[s].uuid;
                });
            }
            next();
        },

        /*
         * Sets `ctx.servers` which contains an array of all the servers that
         * are running and we're interested into checking agent instances.
         *
         * If a server isn't available, we'll include into a comment to stdout
         * and log it for later review. And won't check any instance associated
         * with the server.
         */
        function checkServersAvailability(ctx, next) {
            ctx.servers = [];
            let unavailable = [];
            let desiredServers = (opts.servers && opts.servers.length) ?
                opts.servers : ctx.allServers;
            desiredServers.forEach(function (s) {
                let srv = ctx.serverFromUuidOrHostname[s];
                if (srv.status !== 'running' ||
                    (srv.status === 'running' &&
                     srv.transitional_status !== '')) {
                    unavailable.push(srv.uuid);
                } else {
                    ctx.servers.push(
                        ctx.serverFromUuidOrHostname[srv.uuid]);
                }
            });

            if (unavailable.length) {
                self.log.debug({
                    not_available_servers: unavailable.join(',')
                }, 'Servers not available');

                p(util.format(
                    'The following servers are not available and will be' +
                    'ignored:\n%s\n', unavailable.join(',')));
            }
            next();
        },

        function loadSapiAgentInsts(ctx, next) {
            ctx.sapiInsts = {};
            const values = Object.keys(ctx.svcFromName)
                .map(k => ctx.svcFromName[k]);
            // Trying to avoid loading every SAPI instance here:
            vasync.forEachParallel({
                inputs: values,
                func: function loadSapiInstsForSvc(svc, nextSvc) {
                    self.sdcadm.sapi.listInstances({
                        service_uuid: svc.uuid
                    }, function listCb(listErr, insts) {
                        if (listErr) {
                            nextSvc(new errors.SDCClientError(
                                listErr, 'sapi'));
                            return;
                        }
                        for (let i = 0; i < insts.length; i++) {
                            ctx.sapiInsts[insts[i].uuid] = insts[i];
                        }
                        nextSvc();
                    });
                }
            }, next);
        },

        /*
         * Will create `ctx.report` an array including reports for state of
         * every one of the required services into all the given servers. For
         * each service on each server, the following information will be
         * available:
         *
         * {
         *      service_uuid: UUID,
         *      service_name: String,
         *      instance_uuid: UUID,
         *      server_uuid: UUID,
         *      server_hostname: String,
         *      image_uuid_in_service: UUID,
         *      image_uuid_in_instance: UUID,
         *      image_uuid_in_server: UUID
         * }
         */
        function createAgentStateReport(ctx, next) {
            // Note that we need to lookup all the services into all the
            // servers just in case we have a server with a missing service,
            // on whose case the fix would be to create a new instance for
            // the given service.
            ctx.report = [];
            let numServers = ctx.servers.length;
            for (let i = 0; i < numServers; i++) {
                let agents = ctx.serverFromUuidOrHostname[ctx.servers[i].uuid]
                    .agents;
                let services = Object.keys(ctx.svcFromName);
                for (let j = 0, numAgents = agents.length; j < numAgents; j++) {
                    let pos = services.indexOf(agents[j].name);
                    if (pos !== -1) {
                        let agent = agents[j];
                        let svc = ctx.svcFromName[agent.name];
                        let inst = ctx.sapiInsts[agent.uuid];
                        let existingInst = {
                            service_uuid: svc.uuid,
                            service: agent.name,
                            server: ctx.servers[i].uuid,
                            hostname: ctx.servers[i].hostname,
                            instance: agent.uuid,
                            current_image: agent.image_uuid,
                            desired_image: (inst && inst.params &&
                                inst.params.image_uuid) ?
                                    inst.params.image_uuid :
                                    (svc.params ? svc.params.image_uuid : null)
                        };
                        ctx.report.push(existingInst);
                        services.splice(pos, 1);
                    }
                }
                // Missing agents for the remaining services on this server:
                if (services.length) {
                    for (let k = 0; k < services.length; k++) {
                        let svc = services[k];
                        let missingInst = {
                            service_uuid: svc.uuid,
                            service: svc.name,
                            server: ctx.servers[i].uuid,
                            hostname: ctx.servers[i].hostname,
                            instance: null,
                            current_image: null,
                            desired_image: (
                                svc.params ? svc.params.image_uuid : null)
                        };
                        ctx.report.push(missingInst);
                    }
                }
            }
            next();
        }
    ] }, function checkAgentsCb(err) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, context.report);
    });
};

// --- Check CLI class

function CheckCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm check',
        desc: 'Verification related sdcadm commands.\n' +
              '\n' +
              'These are commands to assist with the common set of tasks\n' +
              'required to check status of the different components on a \n' +
              'typical Triton setup.' +
              '\n',
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        }
    });
}
util.inherits(CheckCLI, Cmdln);

CheckCLI.prototype.init = function init(_opts, _args, _callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;
    this.check = new Check(this.top);
    Cmdln.prototype.init.apply(this, arguments);
};


CheckCLI.prototype.do_server_agents =
function do_server_agents(subcmd, opts, args, cb) {
    const self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (args[0] && args[0] === 'help') {
        cb(new errors.UsageError(
            'Please use `' + this.top.name +
            ' check help server-agents` instead'));
        return;
    }

    let options = {};

    for (let i = 0; i < args.length; i++) {
        let arg = args[i];
        let k = 'svc';
        let v = arg;
        const equal = arg.indexOf('=');
        if (equal !== -1) {
            k = arg.slice(0, equal);
            v = arg.slice(equal + 1);
        }
        if (k === 'svc') {
            if (!options.svcs) {
                options.svcs = [];
            }
            options.svcs.push(v);
        } else {
            cb(new errors.UsageError(
                'unknown filter "' + k + '"'));
            return;
        }
    }

    if (opts.yes) {
        options.yes = opts.yes;
    }

    if (opts.servers) {
        options.servers = opts.servers;
    }

    let columns = opts.o.trim().split(/\s*,\s*/g);
    let sort = opts.sort.trim().split(/\s*,\s*/g);

    self.check.checkServerAgents(options,
        function checkAgentsCb(err, rows) {
            if (err) {
                cb(err);
                return;
            }
            console.log(util.inspect(rows, false, 8, true));

            let validFieldsMap = {};

            rows.forEach(function (v) {
                let k;
                for (k in v) {
                    validFieldsMap[k] = true;
                }
            });

            if (opts.abbr) {
                rows = rows.map(function (r) {
                    let ii;
                    for (ii in r) {
                        if (r[ii] && r[ii].match(common.UUID_RE)) {
                            r[ii] = r[ii].slice(0, 8);
                        }
                    }
                    return r;
                });
            }

            tabula(rows, {
                skipHeader: opts.H,
                columns: columns,
                sort: sort,
                validFields: Object.keys(validFieldsMap)
            });

            cb();
        });
};

CheckCLI.prototype.do_server_agents.help = (
    'Verify status of agent instances installed into Triton servers.\n' +
    '\n' +
    'It\'s possible to verify the status for one or more given services\n' +
    'and/or for one or more servers. By default, all the agent services\n' +
    'in all servers will be checked.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} server-agents\n' +
    '     {{name}} server-agents cn-agent vm-agent\n' +
    '     {{name}} server-agents svc=net-agent svc=firewaller\n' +
    'Examples:\n' +
    '    # Check only setup servers with the "pkg=aegean" trait.\n' +
    '    {{name}} check server-agents \\\n' +
    '        -s $(sdc-server lookup --comma traits.pkg=agean)\n' +
    '\n' +
    '    # Check cn-agent only into setup servers, excluding those with a\n' +
    '    #  "internal=PKGSRC" trait.\n' +
    '    {{name}} check server-agents \\\n' +
    '        -s $(sdc-server lookup --comma  \\\n' +
    '        setup=true \'traits.internal!~PKGSRC\') cn-agent\n' +
    '\n' +
    '\n' +
    '{{options}}'
);
CheckCLI.prototype.do_server_agents.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfCommaSepString',
        help: 'Comma separated list of servers (either hostnames or uuids) ' +
            'where agents will be verified. If nothing is said, all setup ' +
            'servers are assumed.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Display information for every instance of the required ' +
            'agents into all the desired servers. ' +
            '(By default only instances with issues will be shown)'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o', 'output'],
        type: 'string',
        default: 'service,hostname,instance,current_image,desired_image',
        help: 'Specify fields (columns) to output. \'service_uuid\' and ' +
            '\'server\'(uuid) can be added to the default fields.' +
            'Default is ' +
            '"-service,hostname,instance,current_image,desired_image".',
        helpArg: 'field1,...'
    },
    {
        names: ['sort'],
        type: 'string',
        default: '-service,hostname,current_image,desired_image',
        help: 'Sort on the given fields. Default is ' +
            '"-service,hostname,current_image,desired_image".',
        helpArg: 'field1,...'
    },
    {
        names: ['abbr'],
        type: 'bool',
        help: 'Abbreviate Agent Instances and Image UUIDs for compact view'
    }
];

// --- exports

module.exports = {
    CheckCLI: CheckCLI
};
