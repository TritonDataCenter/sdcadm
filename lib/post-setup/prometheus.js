/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup prometheus' CLI subcommand.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;
var runProcs = require('../procedures').runProcs;

function do_prometheus(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    const svcName = 'prometheus';
    const procOpts = {
        svcName: svcName,
        packageName: 'sdc_1024',
        delegatedDataset: true,
        networks: [
            {name: 'admin'},
            // Prometheus needs to be on the external to properly work with
            // CMON's Triton service discovery and CNS -- at least until CNS
            // supports split horizon DNS to provide separate records on the
            // admin network.
            //
            // Triton's Prometheus instances will therefore have a NIC on CMON's
            // non-admin network. Currently by default that is the "external"
            // network.
            //
            // A firewall will be setup on prometheus0 so that by default no
            // inbound requests are allowed on that interface.
            {name: 'external', primary: true}
        ],
        firewallEnabled: true
    };

    if (opts.image) {
        procOpts.image = opts.image;
    }

    if (opts.channel) {
        procOpts.channel = opts.channel;
    }

    if (opts.server) {
        procOpts.server = opts.server;
    }

    const proc = new AddServiceProc(procOpts);

    runProcs({
        log: self.log,
        procs: [proc],
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, function addedService(err) {
        if (err) {
            cb(err);
            return;
        }
        /*
         * If we aborted before creating the vm or retrieving the existing vm,
         * we don't attempt to add it to the allow_transfer list. This can
         * happen, for example, if the user answers "no" at the confirmation
         * prompt.
         */
        if (proc.svcVm) {
            add_cns_allow_transfer(proc.svcVm, cb);
        }
    });

    /*
     * Adds the Prometheus vm's admin IP to CNS's list of IPs that are allowed
     * to issue AXFR/IXFR requests, if the IP is not already in the list.
     */
    function add_cns_allow_transfer(vm, callback) {
        var sapi = self.sdcadm.sapi;

        /*
         * Get the admin IP of the Prometheus vm
         */
        var ip;
        for (var i = 0; i < vm.nics.length; i++) {
            var nic = vm.nics[i];
            if (nic.nic_tag === 'admin') {
                ip = nic.ip;
            }
        }
        if (ip === undefined) {
            callback(new errors.InternalError(
                'Prometheus vm %s has no admin ip', vm.uuid));
            return;
        }

        self.ui.info('Prometheus admin IP: ' + ip);

        vasync.pipeline({
            // ctx
            arg: {},
            funcs: [
                function getCnsSvc(ctx, next) {
                    sapi.listServices({
                        name: 'cns',
                        application: self.sdcadm.sdcApp.uuid
                    }, function gotCnsSvc(err, svcs) {
                        if (err) {
                            next(err);
                            return;
                        }
                        assert.equal(svcs.length, 1, 'svcs.length == 1');
                        ctx.cnsSvc = svcs[0];
                        next();
                    });
                },
                /*
                 * Update the cns service with the Prometheus vm's admin IP, if
                 * necessary.
                 */
                function updateCnsSvc(ctx, next) {
                    var existingIps = ctx.cnsSvc.metadata.allow_transfer;
                    if (existingIps.indexOf(ip) > -1) {
                        self.ui.info('Prometheus admin IP already in CNS ' +
                            'allow_transfer list; not adding');
                        next();
                        return;
                    }
                    existingIps.push(ip);
                    sapi.updateService(ctx.cnsSvc.uuid, {
                        metadata: {
                            allow_transfer: existingIps
                        }
                    }, function updatedCnsSvc(err, _) {
                        if (err) {
                            next(err);
                            return;
                        }
                        self.ui.info('Added Prometheus admin IP to CNS ' +
                            'allow_transfer list');
                        next();
                    });
                }
            ]
        }, function done(err) {
            callback(err);
        });
    }
}

do_prometheus.options = [
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

do_prometheus.help = [
    'Create the "prometheus" service and a first instance.',
    '',
    'Usage:',
    '     {{name}} prometheus',
    '',
    '{{options}}',
    'The "prometheus" service monitors Triton components using the ' +
    'Prometheus time-series database.'
].join('\n');

do_prometheus.logToFile = true;

// --- exports

module.exports = {
    do_prometheus: do_prometheus
};

// vim: set softtabstop=4 shiftwidth=4:
