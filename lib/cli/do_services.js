/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var tabula = require('tabula');

var errors = require('../errors');

/*
 * The 'sdcadm services (svcs)' CLI subcommand.
 */

function do_services(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    var i;
    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);
    var needInsts = opts.json || ~columns.indexOf('insts');

    function getInstsIfNecessary(next) {
        if (!needInsts) {
            return next();
        }
        self.sdcadm.listInsts(next);
    }

    getInstsIfNecessary(function (iErr, insts) {
        if (iErr) {
            return callback(iErr);
        }
        self.sdcadm.getServices({}, function (err, svcs) {
            if (err) {
                return callback(err);
            }

            if (needInsts) {
                var countFromSvcName = {};
                for (i = 0; i < insts.length; i++) {
                    var svcName = insts[i].service;
                    if (countFromSvcName[svcName] === undefined) {
                        countFromSvcName[svcName] = 1;
                    } else {
                        countFromSvcName[svcName]++;
                    }
                }
                for (i = 0; i < svcs.length; i++) {
                    svcs[i].insts = countFromSvcName[svcs[i].name] || 0;
                }
            }

            if (opts.json) {
                console.log(JSON.stringify(svcs, null, 4));
            } else {
                var validFieldsMap = {};
                var rows = svcs.map(function (svc) {
                    if (svc.type === 'vm') {
                        return {
                            type: svc.type,
                            uuid: svc.uuid,
                            name: svc.name,
                            image: svc.params && svc.params.image_uuid,
                            insts: svc.insts
                        };
                    } else if (svc.type === 'agent') {
                        return {
                            type: svc.type,
                            uuid: svc.uuid,
                            name: svc.name,
                            image: null,
                            insts: svc.insts
                        };
                    } else {
                        self.log.warn({svc: svc}, 'unknown service type');
                    }
                }).filter(function (svc) {
                    // Filter out `undefined` entries.
                    return svc;
                });
                rows.forEach(function (v) {
                    for (var k in v) {
                        validFieldsMap[k] = true;
                    }
                });
                tabula(rows, {
                    skipHeader: opts.H,
                    columns: columns,
                    sort: sort,
                    validFields: Object.keys(validFieldsMap)
                });
            }
            callback();
        });
    });
}
do_services.options = [
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
        default: 'type,uuid,name,image,insts',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,name',
        help: 'Sort on the given fields. Default is "-type,name".',
        helpArg: 'field1,...'
    }
];
do_services.aliases = ['svcs'];
do_services.help = (
    'List all SDC services.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} services [<options>]\n'
    + '\n'
    + '{{options}}'
);

// --- exports

module.exports = {
    do_services: do_services
};
