// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SQBase} from "./SQBase.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev A CRE forwarder is only transport: bad signatures, metadata and malformed reports never authorize anything.
contract SQControllerCREAuthTest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 internal id;
    ISQController.Verdict internal v;

    function setUp() public override {
        super.setUp();
        id = setupSubmitted(2);
        v = mkAccept(id, 0);
    }

    function _fwds() internal view returns (address[2] memory f) {
        f[0] = simForwarder;
        f[1] = prodForwarder;
    }

    function _vm() internal view returns (ISQController.Verdict memory) {
        return v;
    }

    function _assertUntouched(bytes32 fp) internal view {
        assertEq(fingerprint(id), fp, "nothing stored");
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0));
        assertEq(sq.getState(id).credited, 0);
        assertEq(sq.feeBalance(rA) + sq.feeBalance(rB), 0, "nothing credited");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    /// @dev Delivers `sig` from each forwarder; every delivery must revert InvalidSignature and leave no trace.
    function _badSigEverywhere(bytes memory sig) internal {
        ISQController.Verdict memory vv = _vm();
        bytes32 fp = fingerprint(id);
        address[2] memory f = _fwds();
        for (uint256 i; i < 2; ++i) {
            vm.recordLogs();
            deliverExpectRevert(f[i], vv, sig, abi.encodePacked(ISQController.InvalidSignature.selector));
            assertEq(vm.getRecordedLogs().length, 0);
            _assertUntouched(fp);
        }
    }

    // ------------------------------------------------------------------ bad signatures

    function test_RevertWhen_ReportSignedByWrongSigner() public {
        _badSigEverywhere(signDigest(0xBAD, sq.hashVerdict(_vm())));
    }

    function test_RevertWhen_ReportSignatureIsGarbage() public {
        _badSigEverywhere(hex"deadbeef");
        _badSigEverywhere(new bytes(65));
        _badSigEverywhere(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27)));
    }

    function test_RevertWhen_ReportSignatureIsEmpty() public {
        _badSigEverywhere("");
    }

    function test_RevertWhen_SignatureCoversTamperedField() public {
        ISQController.Verdict memory t = _vm();
        t.evidenceHash = keccak256("tampered");
        _badSigEverywhere(signVerdict(t)); // valid signature, but over a different verdict
        t = _vm();
        t.includedMask = 1;
        _badSigEverywhere(signVerdict(t));
        t = _vm();
        t.deliverable = keccak256("swapped deliverable");
        _badSigEverywhere(signVerdict(t));
        t = _vm();
        t.kind = ISQController.VerdictKind.Reject;
        _badSigEverywhere(signVerdict(t));
        t = _vm();
        t.round = 1;
        _badSigEverywhere(signVerdict(t));
    }

    function test_RevertWhen_SignatureIsHighSMalleated() public {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(authorityKey, sq.hashVerdict(_vm()));
        bytes memory flipped = abi.encodePacked(r, bytes32(SECP_N - uint256(s)), vv == 27 ? uint8(28) : uint8(27));
        _badSigEverywhere(flipped);
    }

    function test_RevertWhen_SignatureForOtherDomain() public {
        ISQController.Verdict memory vv = _vm();
        _badSigEverywhere(signDigest(authorityKey, digestFor(vv, POLICY, SNAPSHOT, 999, address(sq))));
        _badSigEverywhere(signDigest(authorityKey, digestFor(vv, POLICY, SNAPSHOT, block.chainid, address(ac))));
        _badSigEverywhere(signDigest(authorityKey, digestFor(vv, keccak256("p2"), SNAPSHOT, block.chainid, address(sq))));
    }

    function test_ValidSignatureFromBothForwardersStillWorks() public {
        // control: the correct signature is accepted through the production forwarder
        deliverSigned(prodForwarder, _vm());
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function testFuzz_RevertWhen_RandomSignatureBytes(bytes calldata sig, bool prod) public {
        ISQController.Verdict memory vv = _vm();
        bytes32 fp = fingerprint(id);
        deliverExpectRevert(
            prod ? prodForwarder : simForwarder, vv, sig, abi.encodePacked(ISQController.InvalidSignature.selector)
        );
        _assertUntouched(fp);
    }

    // ------------------------------------------------------------------ metadata is never authority

    function _metas() internal view returns (bytes[] memory m) {
        m = new bytes[](7);
        m[0] = "";
        m[1] = new bytes(62);
        m[2] = creMetadata();
        m[3] = abi.encodePacked(bytes32(0), bytes10(0), authority); // forged workflowOwner == verdictAuthority
        m[4] = new bytes(20_000);
        m[5] = abi.encode(_vm()); // the verdict itself
        m[6] = abi.encodePacked(sq.hashVerdict(_vm()), authority, simForwarder, prodForwarder);
    }

    function test_RevertWhen_UnsignedVerdictInjectedWithAnyMetadata() public {
        bytes[] memory metas = _metas();
        address[2] memory f = _fwds();
        bytes32 fp = fingerprint(id);
        for (uint256 i; i < metas.length; ++i) {
            for (uint256 j; j < 2; ++j) {
                vm.expectRevert(ISQController.InvalidSignature.selector);
                deliverRaw(f[j], metas[i], encodeReport(_vm(), ""));
                vm.expectRevert(ISQController.InvalidSignature.selector);
                deliverRaw(f[j], metas[i], encodeReport(_vm(), hex"deadbeef"));
            }
        }
        _assertUntouched(fp);
    }

    function test_RevertWhen_ValidSignatureSmuggledInMetadataOnly() public {
        bytes memory goodSig = signVerdict(_vm());
        bytes32 fp = fingerprint(id);
        address[2] memory f = _fwds();
        bytes memory wrongSigReport = encodeReport(_vm(), signDigest(0xBAD, sq.hashVerdict(_vm())));
        bytes memory emptySigReport = encodeReport(_vm(), "");
        for (uint256 j; j < 2; ++j) {
            vm.expectRevert(ISQController.InvalidSignature.selector);
            deliverRaw(f[j], goodSig, emptySigReport);
            vm.expectRevert(ISQController.InvalidSignature.selector);
            deliverRaw(f[j], abi.encode(goodSig), wrongSigReport);
        }
        _assertUntouched(fp);
    }

    function test_ValidReportDeliveredWithEmptyMetadata() public {
        deliverRaw(simForwarder, "", encodeReport(_vm(), signVerdict(_vm())));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_ValidReportDeliveredWithHugeMetadata() public {
        deliverRaw(prodForwarder, new bytes(20_000), encodeReport(_vm(), signVerdict(_vm())));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_ValidReportDeliveredWithForgedWorkflowOwner() public {
        bytes memory forged = abi.encodePacked(bytes32(0), bytes10(0), stranger);
        deliverRaw(simForwarder, forged, encodeReport(_vm(), signVerdict(_vm())));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function testFuzz_MetadataNeverAffectsOutcome(bytes calldata meta, bool prod) public {
        address fwd = prod ? prodForwarder : simForwarder;
        bytes memory bad = encodeReport(_vm(), hex"00");
        vm.expectRevert(ISQController.InvalidSignature.selector);
        deliverRaw(fwd, meta, bad);
        deliverRaw(fwd, meta, encodeReport(_vm(), signVerdict(_vm())));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    // ------------------------------------------------------------------ malformed report bytes

    function _validReport() internal view returns (bytes memory) {
        return encodeReport(_vm(), signVerdict(_vm()));
    }

    function _setWord(bytes memory b, uint256 wordIndex, uint256 val) internal pure {
        assembly {
            mstore(add(add(b, 32), mul(wordIndex, 32)), val)
        }
    }

    function _truncate(bytes memory b, uint256 newLen) internal pure {
        assembly {
            mstore(b, newLen)
        }
    }

    function _expectMalformed(bytes memory report) internal {
        bytes32 fp = fingerprint(id);
        address[2] memory f = _fwds();
        for (uint256 j; j < 2; ++j) {
            vm.expectRevert();
            deliverRaw(f[j], creMetadata(), report);
        }
        _assertUntouched(fp);
    }

    function test_RevertWhen_ReportEmpty() public {
        _expectMalformed("");
    }

    function test_RevertWhen_ReportTooShort() public {
        _expectMalformed(hex"01");
        _expectMalformed(new bytes(31));
        _expectMalformed(new bytes(32));
    }

    function test_RevertWhen_ReportTruncated() public {
        bytes memory r = _validReport();
        _truncate(r, 100);
        _expectMalformed(r);
        r = _validReport();
        _truncate(r, r.length - 33); // cuts into the signature bytes
        _expectMalformed(r);
        r = _validReport();
        _truncate(r, 8 * 32); // verdict only
        _expectMalformed(r);
    }

    function test_RevertWhen_ReportHasWrongTupleShape() public {
        _expectMalformed(abi.encode(uint256(1), uint256(2)));
        _expectMalformed(abi.encode(_vm())); // verdict without signature
        _expectMalformed(abi.encode(_vm(), uint256(5))); // signature "offset" is a scalar
        _expectMalformed(abi.encode(signVerdict(_vm()))); // signature without verdict
        _expectMalformed(abi.encode(uint256(0), uint256(0), uint256(0))); // garbage words
    }

    function test_RevertWhen_ReportKindOutOfEnumRange() public {
        bytes memory r = _validReport();
        _setWord(r, 2, 4); // kind word: valid enum is 0..3
        _expectMalformed(r);
        r = _validReport();
        _setWord(r, 2, type(uint256).max);
        _expectMalformed(r);
    }

    function test_RevertWhen_ReportRoundDoesNotFitUint8() public {
        bytes memory r = _validReport();
        _setWord(r, 1, 256);
        _expectMalformed(r);
    }

    function test_RevertWhen_ReportSignatureOffsetOrLengthOutOfBounds() public {
        bytes memory r = _validReport();
        _setWord(r, 8, type(uint64).max); // signature offset
        _expectMalformed(r);
        r = _validReport();
        _setWord(r, 9, 1 << 40); // signature length
        _expectMalformed(r);
    }

    function testFuzz_RevertWhen_ArbitraryBytesDoNotChangeState(bytes calldata junk, bool prod) public {
        bytes32 fp = fingerprint(id);
        vm.prank(prod ? prodForwarder : simForwarder);
        // arbitrary junk may decode to an unregistered/invalid verdict; it must never succeed
        try sq.onReport(creMetadata(), junk) {
            revert("junk report must not be accepted");
        } catch {}
        _assertUntouched(fp);
    }
}
