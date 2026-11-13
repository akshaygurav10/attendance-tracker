'use strict';
// Legacy password hashes are lowercase hex SHA-256 (32 bytes). Never logged.

function hexToHashBuffer(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    const buf = Buffer.from(hex, 'hex');
    return buf.length === 32 ? buf : null;
}

function isUsableHash(hex) { return hexToHashBuffer(hex) !== null; }

module.exports = { hexToHashBuffer, isUsableHash };
