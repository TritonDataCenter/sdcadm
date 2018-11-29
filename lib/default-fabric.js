/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
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
            cb(listErr);
            return;
        }
        for (var i = 0; i < vlans.length; i++) {
            if (vlans[i].name === vlanCfg.name) {
                opts.progress('Already have default fabric VLAN for account %s',
                    opts.account);
                cb(null, vlans[i]);
                return;
            }
        }
        napi.createFabricVLAN(opts.account, vlanCfg, function (err, vlan) {
            if (err) {
                cb(new errors.SDCClientError(err, 'napi'));
                return;
            }
            opts.progress('Created default fabric VLAN\n' +
                '(name: "%s", ID: %d)\nfor account %s',
                vlan.name, vlan.vlan_id, opts.account);
            cb(null, vlan);
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
       resolvers: opts.sdcadm.sdcApp.metadata.dns_resolvers.split(','),
       vlan_id: 2
    };

    var napi = opts.sdcadm.napi;
    napi.listFabricNetworks(opts.account, netCfg.vlan_id, {},
            function (listErr, nets) {
        if (listErr) {
            cb(listErr);
            return;
        }
        for (var i = 0; i < nets.length; i++) {
            if (nets[i].name === netCfg.name) {
                opts.progress(
                    'Already have default fabric network for account %s',
                    opts.account);
                cb(null, nets[i]);
                return;
            }
        }
        napi.createFabricNetwork(opts.account, netCfg.vlan_id, netCfg,
                function (err, net) {
            if (err) {
                cb(new errors.SDCClientError(err, 'napi'));
                return;
            }
            opts.progress('Created default fabric network\n' +
                '(subnet: %s, ID: %s)\nfor account %s',
                net.subnet, net.uuid, opts.account);
            cb(null, net);
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
        function ensureSdcApp(_, next) {
            opts.sdcadm.ensureSdcApp({}, next);
        },
        defFabricAddVLAN,
        defFabricAddNetwork
    ]}, function (err, results) {
        if (err) {
            cb(err);
            return;
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
        cb(new errors.UsageError('Must specify account'));
        return;
    }

    vasync.pipeline({arg: {}, funcs: [
        function ensureAccountUuid(ctx, next) {
            if (common.UUID_RE.test(args[0])) {
                ctx.account = args[0];
                next();
                return;
            }
            self.sdcadm.ufds.getUser(args[0], function (err, account) {
                if (err) {
                    next(err);
                    return;
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

do_default_fabric.logToFile = true;


module.exports = {
    do_default_fabric: do_default_fabric,
    addDefaultFabric: addDefaultFabric
};
