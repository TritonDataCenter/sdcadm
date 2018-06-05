/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var tabula = require('tabula');

var common = require('../common');
var errors = require('../errors');

/*
 * The 'sdcadm instances (insts)' CLI subcommand.
 */

function do_instances(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    }

    var validTypes = ['vm', 'agent'];
    var listOpts = {};
    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        var k = 'svc';
        var v = arg;
        var equal = arg.indexOf('=');
        if (equal !== -1) {
            k = arg.slice(0, equal);
            v = arg.slice(equal + 1);
        }
        switch (k) {
        case 'svc':
            if (!listOpts.svcs) {
                listOpts.svcs = [];
            }
            listOpts.svcs.push(v);
            break;
        case 'type':
            if (validTypes.indexOf(v) === -1) {
                callback(new errors.UsageError(
                    'invalid instance type: ' + v));
                return;
            }
            if (!listOpts.types) {
                listOpts.types = [];
            }
            listOpts.types.push(v);
            break;
        default:
            callback(new errors.UsageError(
                'unknown filter "' + k + '"'));
            return;
        }
    }

    var columns = opts.o.trim().split(/\s*,\s*/g);
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.sdcadm.listInsts(listOpts, function (err, insts) {
        if (err) {
            callback(err);
            return;
        }

        var rows = insts;
        if (opts.group_by_image) {
            var rowFromTypeSvcImage = {};
            for (var j = 0; j < insts.length; j++) {
                var inst = insts[j];
                // `|| inst.version` necessary until agents and platforms
                // use images.
                var key = [inst.type, inst.service,
                    inst.image || inst.version].join('/');
                if (rowFromTypeSvcImage[key] === undefined) {
                    rowFromTypeSvcImage[key] = {
                        type: inst.type,
                        service: inst.service,
                        version: inst.version,
                        image: inst.image,
                        instances: [inst.instance]
                    };
                } else {
                    rowFromTypeSvcImage[key].instances.push(inst.instance);
                }
            }
            rows = Object.keys(rowFromTypeSvcImage).map(function (tsi) {
                var row = rowFromTypeSvcImage[tsi];
                row.count = row.instances.length;
                return row;
            });
            columns = ['service', 'image', 'version', 'count'];
        }

        common.sortArrayOfObjects(rows, sort);
        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
        } else {
            tabula(rows, {
                skipHeader: opts.H,
                columns: columns
            });
        }
        callback();
    });
}
do_instances.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'instance,service,hostname,version,alias',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,service,hostname,version,alias',
        help: 'Sort on the given fields. Default is ' +
            '"-type,service,hostname,version,alias".',
        helpArg: 'field1,...'
    },
    {
        names: ['group-by-image', 'I'],
        type: 'bool',
        help: 'Group by unique (service, image).'
    }
];
do_instances.aliases = ['insts'];
do_instances.help = (
    'List all (or a filtered subset of) SDC service instances.\n' +
    'Note that "service" here includes SDC core vms and global zone agents.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} instances [<options>] [<filter>...]\n' +
    '\n' +
    '{{options}}\n' +
    'Instances can be filtered via <filter> by type:\n' +
    '    type=vm\n' +
    '    type=agent\n' +
    'and service name:\n' +
    '    svc=imgapi\n' +
    '    imgapi\n' +
    '    cnapi cn-agent\n'
);

// --- exports

module.exports = {
    do_instances: do_instances
};
