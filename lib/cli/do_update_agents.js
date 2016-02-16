/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var errors = require('../errors');

/*
 * The 'sdcadm experimental update-agents' CLI subcommand.
 */

/*
 * Update agents in datancenter with a given or latest agents installer.
 */

function do_update_agents(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }
    if (!opts.latest && !args[0]) {
        return cb(new errors.UsageError('must specify an AGENTSSHAR: ' +
            '--latest, an updates server UUID, or a download agentsshar ' +
            'package'));
    }

    var agentsshar = (!opts.latest) ? args.shift() : 'latest';
    var servers = args.length ? args : undefined;

    if (opts.all && servers) {
        return cb(new errors.UsageError(
            'cannot specify "--all" and explicit servers: ' +
            servers.join(' ')));
    } else if (!opts.all && !servers && !opts.just_download) {
        return cb(new errors.UsageError(
            'either --all option or explicitly specifying ' +
            'SERVER(s) is required'));
    }

    return self.sdcadm.updateAgents({
        agentsshar: agentsshar,
        progress: self.progress,
        justDownload: opts.just_download,
        yes: opts.yes,
        servers: servers,
        all: opts.all,
        concurrency: Number(opts.concurrency)
    }, cb);
}
do_update_agents.help = (
    /* BEGIN JSSTYLED */
    'Update GZ agents on servers in the DC.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} update-agents [OPTIONS] AGENTSSHAR --all\n' +
    '    {{name}} update-agents [OPTIONS] AGENTSSHAR [SERVER ...]\n' +
    '    {{name}} update-agents [OPTIONS] AGENTSSHAR --just-download\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'Where AGENTSSHAR is one of "--latest" (the latest agentsshar package in the\n' +
    'current channel of the update server), an agentsshar UUID in the updates\n' +
    'server, or a path to a locally downloaded agentsshar package.\n' +
    '\n' +
    'Agents may only be updated on servers that are *setup*. Use "--all" for\n' +
    'all setup servers, or pass a specific set of SERVERs. A "SERVER" is a server\n' +
    'UUID or hostname. In a larger datacenter, getting a list of the wanted\n' +
    'servers can be a chore. The "sdc-server lookup ..." tool is useful for this.\n' +
    '\n' +
    'Examples:\n' +
    '    # Update to the latest agentsshar on all setup servers.\n' +
    '    {{name}} update-agents --latest --all\n' +
    '\n' +
    '    # Update a specific agentsshar on setup servers with the "pkg=aegean" trait.\n' +
    '    {{name}} update-agents 8198c6c0-778c-11e5-8416-13cb06970b44 \\\n' +
    '        $(sdc-server lookup setup=true traits.pkg=aegean)\n' +
    '\n' +
    '    # Update on setup servers, excluding those with a "internal=PKGSRC" trait.\n' +
    '    {{name}} update-agents 8198c6c0-778c-11e5-8416-13cb06970b44 \\\n' +
    '        $(sdc-server lookup setup=true \'traits.internal!~PKGSRC\')\n'
    /* END JSSTYLED */
);
do_update_agents.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published agents installer.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the agents installer for later usage.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Update on all setup servers.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['concurrency', 'j'],
        type: 'integer',
        'default': 5,
        help: 'Number of concurrent servers downloading agentsshar file or ' +
            'being updated simultaneously. Default: 5',
        helpArg: 'N'
    }
];

// --- exports

module.exports = {
    do_update_agents: do_update_agents
};
