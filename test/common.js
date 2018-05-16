/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

var exec = require('child_process').exec;
var util = require('util');

var vasync = require('vasync');

var DEFAULT_VM_SERVICES = [
    'adminui', 'amon', 'amonredis', 'assets', 'binder', 'ca', 'cnapi', 'dhcpd',
    'fwapi', 'imgapi', 'mahi', 'manatee', 'moray', 'napi', 'papi', 'rabbitmq',
    'redis', 'sapi', 'sdc', 'ufds', 'vmapi', 'workflow'
];

var ALL_VM_SERVICES = DEFAULT_VM_SERVICES.concat([
    'portolan', 'cloudapi', 'docker', 'cns'
]);

var DEFAULT_AGENT_SERVICES = [
    'amon-agent', 'amon-relay', 'cainstsvc', 'firewaller',
    'cn-agent', 'vm-agent', 'net-agent', 'smartlogin',
    'hagfish-watcher'
];

var ALL_AGENT_SERVICES = DEFAULT_AGENT_SERVICES.concat(['dockerlogger']);

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj)); // heh
}


function parseJsonOut(output) {
    try {
        return JSON.parse(output);
    } catch (_) {
        return null; // dodgy
    }
}


function parseTextOut(output) {
    return output.split('\n').filter(function (r) {
        return r !== '';
    }).map(function (r) {
        return r.split(/\s+/);
    });
}


function checkHelp(t, subcommand, match) {
    exec('sdcadm help ' + subcommand, function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf(match), -1);
        t.equal(stderr, '');

        t.end();
    });
}

/*
 * This function checks expected output from `sdcadm insts` and
 * `sdcadm health`, which share approximately eighty percent.
 *
 * The expected opts argument includes the output from those
 * commands, server hostnames associated with server uuids and
 * service names associated with service uuids.
 */
function checkInsts(t, opts, cb) {
    var inputs = opts.inputs;
    var serviceNamesFromUUID = opts.serviceNamesFromUUID;
    var serverHostnamesFromUUID = opts.serverHostnamesFromUUID;

    vasync.forEachPipeline({
        func: function (item, next) {

            if (item.service === 'global' || item.instance === '-') {
                next();
                return;
            }

            var description = (item.alias !== '-') ?
                util.format('%s (%s)', item.alias, item.instance) :
                util.format('%s (%s)', item.instance, item.service);
            t.comment(util.format('checking %s in %s',
                description, item.hostname));



            var cmd2 = 'sdc-sapi /instances/' + item.instance + ' | json -H';
            exec(cmd2, function (err2, stdout2, stderr2) {
                t.ifError(err2, 'no SAPI error');
                var instanceDetails = parseJsonOut(stdout2);
                if (!instanceDetails) {
                    t.ok(false, 'failed to parse JSON for cmd ' + cmd2);
                    next();
                    return;
                }

                if (item.service !== 'assets') {
                    t.equal(serviceNamesFromUUID[instanceDetails.service_uuid],
                        item.service, 'service should match');
                }

                if (item.alias === '-') {
                    next();
                    return;
                }

                var cmd = 'sdc-vmapi /vms/' + item.instance + ' | json -H';
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'no VMAPI error');

                    var vmDetails = parseJsonOut(stdout);
                    if (!vmDetails) {
                        t.ok(false, 'failed to parse JSON for cmd ' + cmd);
                        next();
                        return;
                    }

                    t.equal(vmDetails.uuid,  item.instance,
                            'uuid should match');
                    t.equal(vmDetails.alias, item.alias,
                            'alias should match');

                    t.equal(serverHostnamesFromUUID[vmDetails.server_uuid],
                        item.hostname, 'server hostname should match');

                    t.notEqual(vmDetails.state, 'failed',
                            'check state for VM ' + item.instance);

                    if (item.version) {
                        var imgUuid = vmDetails.image_uuid;
                        var cmd3 = 'sdc-imgapi /images/' + imgUuid +
                            ' | json -H';

                        exec(cmd3, function (err3, stdout3, stderr3) {
                            t.ifError(err3, 'IMGAPI call error');

                            var imgInfo = parseJsonOut(stdout3);
                            if (!imgInfo) {
                                t.ok(false, 'failed to parse JSON for cmd ' +
                                        cmd3);
                                next();
                                return;
                            }

                            t.equal(imgInfo.version, item.version,
                                    'check version for VM ' + vmDetails.uuid);

                            next();
                        });
                    } else {
                        next();
                    }
                });
            });
        },
        inputs: inputs
    }, function (resErr) {
        t.ifError(resErr);
        cb();
    });
}


module.exports = {
    DEFAULT_VM_SERVICES: DEFAULT_VM_SERVICES,
    ALL_VM_SERVICES: ALL_VM_SERVICES,
    DEFAULT_AGENT_SERVICES: DEFAULT_AGENT_SERVICES,
    ALL_AGENT_SERVICES: ALL_AGENT_SERVICES,
    UUID_RE: UUID_RE,
    checkHelp: checkHelp,
    deepCopy: deepCopy,
    parseJsonOut: parseJsonOut,
    parseTextOut: parseTextOut,
    checkInsts: checkInsts
};
