/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Logic to deal with the set up and manipulation of fabrics and fabric related
 * options.
 */

var common = require('./common');
var errors = require('./errors');
var fmt = require('util').format;
var mod_uuid = require('node-uuid');
var vasync = require('vasync');


var defFabricHelp = 'Initialize a default fabric for a user.\n' +
    '\n' +
    'Usage: {{name}} default-fabric [-h] <user UUID>\n' +
    '\n' +
    '{{options}}';

var defFabricOpts = [
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'Display this help message'
    }
];

function defFabricAddVLAN(opts, cb) {
    // XXX: this should be stored in the fabrics cfg object
    var vlanCfg = {
        name: 'default',
        vlan_id: 2
    };
    var reqOpts = {
        headers: { 'x-request-id': mod_uuid.v4() }
    };

    opts.napi.createFabricVLAN(opts.fabricUser, vlanCfg, reqOpts,
            function (err, vlan) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'napi'));
        }

        opts.progress(fmt('Created default fabric VLAN (name: "%s", ID: %d)',
            vlan.name, vlan.vlan_id));
        return cb(null, vlan);
    });
}

function defFabricAddNetwork(opts, cb) {
    // XXX: this should be stored in the fabrics cfg object
    var netCfg = {
       name: 'default',
       subnet: '192.168.128.0/22',
       provision_start_ip: '192.168.128.5',
       provision_end_ip: '192.168.131.250',
       gateway: '192.168.128.1',
       resolvers: opts.sapiApp.metadata.dns_resolvers.split(','),
       vlan_id: 2
    };
    var reqOpts = {
        headers: { 'x-request-id': mod_uuid.v4() }
    };

    opts.napi.createFabricNetwork(opts.fabricUser, netCfg.vlan_id, netCfg,
            reqOpts, function (err, net) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'napi'));
        }

        opts.progress(fmt('Created default fabric network (subnet: %s, ID: %s)',
            net.subnet, net.uuid));
        return cb(null, net);
    });
}

function doDefaultFabric(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help === true) {
        this.do_help('help', {}, [ subcmd ], cb);
        return;
    }

    if (args.length !== 1) {
        return cb(new errors.UsageError('Must specify user'));
    }

    if (!common.UUID_RE.test(args[0])) {
        return cb(new errors.UsageError('User must be a UUID'));
    }

    var pipeArgs = {
        fabricUser: args[0],
        napi: this.sdcadm.napi,
        progress: this.progress,
        sapiApp: this.sdcadm.sdc,
        conf: opts.conf
    };

    vasync.pipeline({ funcs: [
        defFabricAddVLAN,
        defFabricAddNetwork
        ], arg: pipeArgs },
        function (err, results) {
            if (err) {
                return cb(err);
            }

            self.progress('Successfully added default fabric for user '
                + pipeArgs.fabricUser);
            cb();
    });
}

doDefaultFabric.help = defFabricHelp;
doDefaultFabric.options = defFabricOpts;

module.exports = {
    doDefaultFabric: doDefaultFabric
};
