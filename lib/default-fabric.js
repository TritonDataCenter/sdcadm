/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Support for adding a default fabric for an account, including
 * `sdcadm experimental default-fabric ...`.
 */

var assert = require('assert-plus');
var common = require('./common');
var errors = require('./errors');
var vasync = require('vasync');



// ---- internal support functions

function defFabricAddVLAN(opts, cb) {
    // XXX: this should be stored in the fabrics cfg object
    var vlanCfg = {
        name: 'default',
        vlan_id: 2
    };

    var napi = opts.sdcadm.napi;
    napi.listFabricVLANs(opts.account, {}, function (listErr, vlans) {
        if (listErr) {
            return cb(listErr);
        }
        for (var i = 0; i < vlans.length; i++) {
            if (vlans[i].name === vlanCfg.name) {
                opts.progress('Already have default fabric VLAN for account %s',
                    opts.account);
                return cb(null, vlans[i]);
            }
        }
        napi.createFabricVLAN(opts.account, vlanCfg, function (err, vlan) {
            if (err) {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
            opts.progress('Created default fabric VLAN\n' +
                '(name: "%s", ID: %d)\nfor account %s',
                vlan.name, vlan.vlan_id, opts.account);
            return cb(null, vlan);
        });
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
       resolvers: opts.sdcadm.sdc.metadata.dns_resolvers.split(','),
       vlan_id: 2
    };

    var napi = opts.sdcadm.napi;
    napi.listFabricNetworks(opts.account, netCfg.vlan_id, {},
            function (listErr, nets) {
        if (listErr) {
            return cb(listErr);
        }
        for (var i = 0; i < nets.length; i++) {
            if (nets[i].name === netCfg.name) {
                opts.progress(
                    'Already have default fabric network for account %s',
                    opts.account);
                return cb(null, nets[i]);
            }
        }
        napi.createFabricNetwork(opts.account, netCfg.vlan_id, netCfg,
                function (err, net) {
            if (err) {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
            opts.progress('Created default fabric network\n' +
                '(subnet: %s, ID: %s)\nfor account %s',
                net.subnet, net.uuid, opts.account);
            return cb(null, net);
        });
    });
}



// ---- exports

/**
 * Add a default fabric for the given account.
 */
function addDefaultFabric(opts, cb) {
    assert.object(opts, 'opts');
    assert.uuid(opts.account, 'opts.account');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');

    vasync.pipeline({ arg: opts, funcs: [
        defFabricAddVLAN,
        defFabricAddNetwork
    ]}, function (err, results) {
        if (err) {
            return cb(err);
        }
        opts.progress('Successfully added default fabric for account %s',
            opts.account);
        cb();
    });
}


function do_default_fabric(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help === true) {
        this.do_help('help', {}, [ subcmd ], cb);
        return;
    } else if (args.length !== 1) {
        return cb(new errors.UsageError('Must specify account'));
    }

    vasync.pipeline({arg: {}, funcs: [
        function ensureAccountUuid(ctx, next) {
            if (common.UUID_RE.test(args[0])) {
                ctx.account = args[0];
                return next();
            }
            self.sdcadm.ufds.getUser(args[0], function (err, account) {
                if (err) {
                    return next(err);
                }
                ctx.account = account.uuid;
                self.sdcadm._ufds.close(next);  // Yuck
            });
        },
        function addIt(ctx, next) {
            var addOpts = {
                account: ctx.account,
                sdcadm: self.sdcadm,
                progress: self.progress
            };
            addDefaultFabric(addOpts, next);
        }
    ]}, cb);
}

do_default_fabric.help = 'Initialize a default fabric for an account.\n' +
    '\n' +
    'Usage: {{name}} default-fabric [-h] <account-uuid>\n' +
    '\n' +
    '{{options}}';

do_default_fabric.options = [
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'Display this help message'
    }
];


module.exports = {
    do_default_fabric: do_default_fabric,
    addDefaultFabric: addDefaultFabric
};
