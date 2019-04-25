/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup firewall-logger' CLI subcommand.
 */


var errors = require('../errors');
var AddAgentServiceProc =
    require('../procedures/add-agent-service').AddAgentServiceProcedure;
var runProcs = require('../procedures').runProcs;

function do_firewall_logger(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    const svcName = 'firewall-logger-agent';

    const procOpts = {
        svcName: svcName,
        concurrency: opts.concurrency
    };

    if (opts.image) {
        procOpts.image = opts.image;
    }

    if (opts.channel) {
        procOpts.channel = opts.channel;
    }

    if (opts.servers) {
        procOpts.includeServerNames = opts.servers;
    }

    if (opts.exclude_servers) {
        procOpts.excludeServerNames = opts.exclude_servers;
    }

    const proc = new AddAgentServiceProc(procOpts);

    runProcs({
        log: self.log,
        procs: [proc],
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, cb);
}

do_firewall_logger.options = [
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
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Do a dry-run.'
    },
    {
        group: 'Server selection (by default all setup servers are updated)'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfCommaSepString',
        helpArg: 'NAMES',
        help: 'Comma-separated list of servers (either hostnames or uuids) ' +
            'on which to update cn_tools.'
    },
    {
        names: ['exclude-servers', 'S'],
        type: 'arrayOfCommaSepString',
        helpArg: 'NAMES',
        help: 'Comma-separated list of servers (either hostnames or uuids) ' +
            'to exclude from cn_tools update.'
    },
    {
        names: ['concurrency', 'j'],
        type: 'integer',
        'default': 5,
        help: 'Number of concurrent servers ' +
            'being updated simultaneously. Default: 5',
        helpArg: 'CONCURRENCY'
    },
    {
        group: 'Image selection (by default latest image on default ' +
            'channel)'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'Specifies which image to use for the first instance. ' +
            'Use "latest" (the default) for the latest available on ' +
            'updates.joyent.com, "current" for the latest image already ' +
            'in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.joyent.com channel from which to fetch the ' +
            'image. See `sdcadm channel get` for the default channel.'
    }

];

do_firewall_logger.help = [
    'Create "firewall-logger-agent" service and the required agent instances.',
    '',
    'Usage:',
    '     {{name}} firewall-logger',
    '',
    '{{options}}',
    'The "firewall-logger-agent" service generates specific Triton log files ' +
    ' for the configured firewall rules.'
].join('\n');

do_firewall_logger.logToFile = true;

// --- exports

module.exports = {
    do_firewall_logger: do_firewall_logger
};

// vim: set softtabstop=4 shiftwidth=4:
