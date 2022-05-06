/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup grafana' CLI subcommand.
 */

var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;
var EnsureNicProc = require('../procedures/ensure-nic-on-instances')
    .EnsureNicOnInstancesProcedure;
var runProcs = require('../procedures').runProcs;

function do_grafana(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    const svcName = 'grafana';
    const addServiceOpts = {
        svcName: svcName,
        packageName: 'sdc_1024',
        delegatedDataset: true,
        networks: [
            {name: 'admin'},
            /*
             * Grafana is on the external network to allow login access from
             * the public internet.
             */
            {name: 'external', primary: true}
        ]
    };

    if (opts.image) {
        addServiceOpts.image = opts.image;
    }

    if (opts.channel) {
        addServiceOpts.channel = opts.channel;
    }

    if (opts.server) {
        addServiceOpts.server = opts.server;
    }

    /*
     * We add the manta nic here, rather than in the hard-coded service json
     * above, because the EnsureNicOnInstancesProcedure will gracefully
     * handle the case where the manta network does not exist.
     *
     * If the manta network doesn't exist, the procedure will do nothing. If
     * `sdcadm post-setup grafana` is run later and the manta network now
     * exists, the procedure will add a manta nic to the existing grafana
     * instance.
     *
     * We set 'volatile' to true here because we're also (possibly) creating the
     * grafana service and instance in the same runProcs sequence, and thus
     * must defer lookup of the service and instance to the execute() phase.
     */
    const ensureNicOpts = {
        svcNames: [ svcName ],
        nicTag: 'manta',
        primary: false,
        hardFail: false,
        volatile: true
    };

    const addServiceProc = new AddServiceProc(addServiceOpts);
    const ensureNicProc = new EnsureNicProc(ensureNicOpts);
    runProcs({
        log: self.log,
        procs: [addServiceProc, ensureNicProc],
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, cb);
}

do_grafana.options = [
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
        names: ['server', 's'],
        type: 'string',
        help: 'Either hostname or uuid of the server on which to create' +
            ' the instance. (By default the headnode will be used.)',
        helpArg: 'SERVER'
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
            'updates.tritondatacenter.com, "current" for the latest image ' +
            'already in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.tritondatacenter.com channel from which to fetch ' +
            'the image. See `sdcadm channel get` for the default channel.'
    }

];

do_grafana.help = [
    'Create the "grafana" service and a first instance.',
    '',
    'Usage:',
    '     {{name}} grafana',
    '',
    '{{options}}',
    'The "grafana" service provides a graphical front-end to the Prometheus ' +
    'time-series database.'
].join('\n');

do_grafana.logToFile = true;

// --- exports

module.exports = {
    do_grafana: do_grafana
};

// vim: set softtabstop=4 shiftwidth=4:
