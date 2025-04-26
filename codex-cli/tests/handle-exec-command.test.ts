import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as execModule from "../src/utils/agent/exec"; // Import the module to mock
import * as approvalsModule from "../src/approvals"; // Import the module to mock canAutoApprove
import * as fsPromises from "fs/promises";
import type { AppConfig } from "../src/utils/config";
import type {
  ApprovalPolicy,
  SafetyAssessment,
  ApplyPatchCommand,
} from "../src/approvals";
import type { ExecInput } from "../src/utils/agent/sandbox/interface";
import { SandboxType } from "../src/utils/agent/sandbox/interface";
import { ReviewDecision } from "../src/utils/agent/review";
import type { CommandConfirmation } from "../src/utils/agent/agent-loop";
import { FullAutoErrorMode } from "../src/utils/auto-approval-mode"; // Correct import path
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs"; // Import for type checking additionalItems

// --- Mocking setup ---
const mockedIsInLinux: Mock<() => Promise<boolean>> = vi
  .fn()
  .mockResolvedValue(false);

// Mock dependencies
vi.mock("../src/utils/agent/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof execModule>();
  return {
    ...actual,
    exec: vi
      .fn()
      .mockResolvedValue({ stdout: "mock stdout", stderr: "", exitCode: 0 }),
    // Mock execApplyPatch if needed for specific tests
    execApplyPatch: vi
      .fn()
      .mockResolvedValue({ stdout: "patch applied", stderr: "", exitCode: 0 }),
  };
});

vi.mock("../src/approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof approvalsModule>();
  return {
    ...actual,
    canAutoApprove: vi.fn().mockReturnValue({
      type: "auto-approve",
      runInSandbox: false,
      applyPatch: undefined,
      reason: "Mocked auto-approval",
      group: "mock_group",
    } as SafetyAssessment),
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined), // Mock access to succeed
  };
});

// Mock logger to prevent console output during tests
vi.mock("../src/utils/logger/log", () => ({
  log: vi.fn(),
  isLoggingEnabled: vi.fn().mockReturnValue(false),
}));

// Mock parts of handle-exec-command (only isInLinux) - Revert to simpler mock
vi.mock("../src/utils/agent/handle-exec-command", async () => {
  // Let TypeScript infer the type of 'actual'
  const actual = await import("../src/utils/agent/handle-exec-command");
  return {
    ...actual,
    isInLinux: mockedIsInLinux, // Only override isInLinux
  };
});

// Import the potentially mocked module *after* vi.mock calls
const handleExecCommandModule = await import(
  "../src/utils/agent/handle-exec-command"
);
const handleExecCommand = handleExecCommandModule.handleExecCommand;

// --- End Mocking Setup ---

describe("handleExecCommand", () => {
  let mockConfig: AppConfig;
  let mockPolicy: ApprovalPolicy;
  let mockExecInput: ExecInput;
  let mockGetCommandConfirmation: Mock<
    (
      command: Array<string>,
      applyPatch: approvalsModule.ApplyPatchCommand | undefined,
    ) => Promise<CommandConfirmation>
  >;

  const mockedExec = vi.mocked(execModule.exec);
  const mockedExecApplyPatch = vi.mocked(execModule.execApplyPatch);
  const mockedCanAutoApprove = vi.mocked(approvalsModule.canAutoApprove);
  const mockedFsAccess = vi.mocked(fsPromises.access);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsInLinux.mockClear().mockResolvedValue(false);

    mockConfig = {
      model: "test-model",
      instructions: "test-instructions",
      tools: {
        shell: {
          maxBytes: 1024,
          maxLines: 100,
        },
      },
      fullAutoErrorMode: undefined,
    };

    mockPolicy = "full-auto";
    // Default input (can be used by tests not sensitive to 'always approved' state)
    mockExecInput = {
      cmd: ["default-cmd"],
      workdir: "/test/dir",
      timeoutInMillis: 5000,
    };
    mockGetCommandConfirmation = vi.fn().mockResolvedValue({
      review: ReviewDecision.YES,
      customDenyMessage: "",
    });

    mockedCanAutoApprove.mockReturnValue({
      type: "auto-approve",
      runInSandbox: false,
      applyPatch: undefined,
      reason: "Mocked auto-approval",
      group: "mock_group",
    } as SafetyAssessment);
    mockedExec.mockResolvedValue({
      stdout: "mock stdout",
      stderr: "",
      exitCode: 0,
    });
    mockedFsAccess.mockResolvedValue(undefined);
  });

  it("should propagate AppConfig correctly to the exec function", async () => {
    await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      ["/additional/writable"],
      mockGetCommandConfirmation,
      undefined,
    );

    expect(mockedFsAccess).toHaveBeenCalledWith(mockExecInput.workdir);

    expect(mockedCanAutoApprove).toHaveBeenCalledWith(
      mockExecInput.cmd,
      mockExecInput.workdir,
      mockPolicy,
      [expect.any(String)],
    );

    expect(mockedExec).toHaveBeenCalledTimes(1);

    const execCallArgs = mockedExec.mock.calls[0];
    expect(execCallArgs).toBeDefined();

    const passedExecInput = execCallArgs![0];
    const passedSandboxType = execCallArgs![1];
    const passedAbortSignal = execCallArgs![2];
    const passedConfig = execCallArgs![3];

    expect(passedConfig).toBeDefined();
    expect(passedConfig).toMatchObject(mockConfig);
    expect(passedConfig?.tools?.shell?.maxBytes).toBe(
      mockConfig.tools?.shell?.maxBytes,
    );
    expect(passedConfig?.tools?.shell?.maxLines).toBe(
      mockConfig.tools?.shell?.maxLines,
    );

    expect(passedExecInput).toEqual({
      ...mockExecInput,
      additionalWritableRoots: ["/additional/writable"],
    });
    expect(passedSandboxType).toBe(SandboxType.NONE);
    expect(passedAbortSignal).toBeUndefined();
  });

  it("should use process.cwd() if workdir access fails", async () => {
    const mockCwd = "/mock/cwd";
    const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
    mockedFsAccess.mockRejectedValue(new Error("Access denied"));

    await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );

    expect(mockedFsAccess).toHaveBeenCalledWith(mockExecInput.workdir);
    expect(mockedCanAutoApprove).toHaveBeenCalledWith(
      mockExecInput.cmd,
      mockExecInput.workdir,
      mockPolicy,
      [mockCwd],
    );
    expect(mockedExec).toHaveBeenCalledTimes(1);

    const execCallArgs = mockedExec.mock.calls[0];
    expect(execCallArgs).toBeDefined();
    const passedExecInput = execCallArgs![0];

    expect(passedExecInput.workdir).toBe(mockCwd);
    expect(passedExecInput.cmd).toEqual(mockExecInput.cmd);

    spyCwd.mockRestore();
  });

  // --- New Tests ---

  it("should run in sandbox if policy dictates (macOS)", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");

    mockedCanAutoApprove.mockReturnValue({
      type: "auto-approve",
      runInSandbox: true,
      applyPatch: undefined,
      reason: "Needs sandbox",
      group: "sandbox_group",
    } as SafetyAssessment);

    try {
      await handleExecCommand(
        mockExecInput,
        mockConfig,
        mockPolicy,
        [],
        mockGetCommandConfirmation,
        undefined,
      );

      expect(mockedExec).toHaveBeenCalledTimes(1);
      const execCallArgs = mockedExec.mock.calls[0];
      expect(execCallArgs).toBeDefined();
      const passedSandboxType = execCallArgs![1];
      expect(passedSandboxType).toBe(SandboxType.MACOS_SEATBELT);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("should run without sandbox if policy dictates (Linux)", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");

    mockedIsInLinux.mockResolvedValue(true);

    mockedCanAutoApprove.mockReturnValue({
      type: "auto-approve",
      runInSandbox: true,
      applyPatch: undefined,
      reason: "Needs sandbox",
      group: "sandbox_group",
    } as SafetyAssessment);

    try {
      await handleExecCommand(
        mockExecInput,
        mockConfig,
        mockPolicy,
        [],
        mockGetCommandConfirmation,
        undefined,
      );

      expect(mockedExec).toHaveBeenCalledTimes(1);
      const execCallArgs = mockedExec.mock.calls[0];
      expect(execCallArgs).toBeDefined();
      const passedSandboxType = execCallArgs![1];
      expect(passedSandboxType).toBe(SandboxType.NONE);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("should ask user for permission if policy dictates and execute apply_patch", async () => {
    const mockApplyPatch: ApplyPatchCommand = {
      patch: "diff --git a/file b/file",
    };
    // Explicitly set canAutoApprove mock for THIS test
    mockedCanAutoApprove.mockReturnValue({
      type: "ask-user", // Ask user
      applyPatch: mockApplyPatch, // Provide the patch command object
      reason: "User review required",
      group: "ask_group",
    } as SafetyAssessment);

    // Use mockResolvedValueOnce for clarity that this is for one call
    mockGetCommandConfirmation.mockResolvedValueOnce({
      review: ReviewDecision.YES,
      customDenyMessage: "",
    });

    // Add intermediate assertion (optional, keep if helpful)
    expect(mockedCanAutoApprove).toHaveBeenCalledTimes(0);
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(0);

    await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );

    // Verify canAutoApprove was called exactly once now
    expect(mockedCanAutoApprove).toHaveBeenCalledTimes(1);
    // Verify getCommandConfirmation was called exactly once now
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);
    expect(mockGetCommandConfirmation).toHaveBeenCalledWith(
      mockExecInput.cmd,
      mockApplyPatch,
    );
    // Verify execApplyPatch WAS called
    expect(mockedExecApplyPatch).toHaveBeenCalledTimes(1);
    // Verify exec was NOT called
    expect(mockedExec).not.toHaveBeenCalled();

    // Verify arguments passed to execApplyPatch
    const applyPatchArgs = mockedExecApplyPatch.mock.calls[0];
    // Add check for defined args
    expect(applyPatchArgs).toBeDefined();
    // Use non-null assertion
    expect(applyPatchArgs![0]).toBe(mockApplyPatch.patch); // Check patch content
    expect(applyPatchArgs![1]).toBe(mockExecInput.workdir); // Check workdir (assuming access succeeds)
  });

  it("should abort if user rejects command", async () => {
    mockedCanAutoApprove.mockReturnValue({
      type: "ask-user", // Ask user
      applyPatch: undefined,
      reason: "User review required",
      group: "ask_group",
    } as SafetyAssessment);
    // Mock user rejects - Use NO_EXIT
    mockGetCommandConfirmation.mockResolvedValueOnce({
      review: ReviewDecision.NO_EXIT,
      customDenyMessage: "",
    });

    const result = await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );

    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);
    expect(mockedExec).not.toHaveBeenCalled(); // Not executed
    expect(result.outputText).toBe("aborted");
    expect(result.metadata?.["error"]).toBeUndefined(); // Access with ['error']
    expect(result.additionalItems).toBeDefined();

    // --- Adjust type assertion and access path ---
    // The item itself has type, role, and content properties
    const firstItem = result.additionalItems?.[0] as ResponseInputItem & {
      type: "message";
      role: string; // Role is at this level
      content: Array<{ type: string; text: string }>; // Content is at this level
    };
    // Access content directly from the firstItem
    expect(firstItem?.content[0]?.text).toContain(
      "No, don't do that — stop for now.",
    );
    // --- End adjustment ---
  });

  it("should abort but add custom message if user rejects with NO_CONTINUE", async () => {
    mockedCanAutoApprove.mockReturnValue({
      type: "ask-user",
      applyPatch: undefined,
      reason: "User review required",
      group: "ask_group",
    } as SafetyAssessment);
    const customMessage = " Stop this specific action ";
    mockGetCommandConfirmation.mockResolvedValueOnce({
      review: ReviewDecision.NO_CONTINUE,
      customDenyMessage: customMessage,
    });

    const result = await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );

    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);
    expect(mockedExec).not.toHaveBeenCalled(); // Not executed
    expect(result.outputText).toBe("aborted");
    expect(result.additionalItems).toBeDefined();

    // --- Adjust type assertion and access path ---
    // The item itself has type, role, and content properties
    const firstItem = result.additionalItems?.[0] as ResponseInputItem & {
      type: "message";
      role: string; // Role is at this level
      content: Array<{ type: string; text: string }>; // Content is at this level
    };
    // Access content directly from the firstItem
    expect(firstItem?.content[0]?.text).toBe(customMessage.trim());
    // --- End adjustment ---
  });

  it('should skip approval prompts for "always approved" commands', async () => {
    // Use a unique command for this test
    const alwaysTestCmd = ["cmd-for-always-test", "v1"];
    const alwaysTestInput = { ...mockExecInput, cmd: alwaysTestCmd };

    // --- First Run ---
    mockedCanAutoApprove.mockReturnValueOnce({
      type: "ask-user",
      applyPatch: undefined,
      reason: "User review required",
      group: "ask_group",
    } as SafetyAssessment);
    mockGetCommandConfirmation.mockResolvedValueOnce({
      review: ReviewDecision.ALWAYS,
      customDenyMessage: "",
    });

    await handleExecCommand(
      alwaysTestInput, // Use unique input
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );
    // Assertions for first run...
    expect(mockedCanAutoApprove).toHaveBeenCalledTimes(1);
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedExecApplyPatch).not.toHaveBeenCalled();

    // --- Second Run ---
    vi.clearAllMocks();
    await handleExecCommand(
      alwaysTestInput, // Use same unique input
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );
    // Assertions for second run...
    expect(mockedCanAutoApprove).not.toHaveBeenCalled();
    expect(mockGetCommandConfirmation).not.toHaveBeenCalled();
    expect(mockedExec).toHaveBeenCalledTimes(1); // Called again
    // ... check args ...
    const execCallArgs = mockedExec.mock.calls[0];
    expect(execCallArgs).toBeDefined();
    const expectedExecArg0 = {
      ...alwaysTestInput,
      additionalWritableRoots: [],
    };
    expect(execCallArgs![0]).toEqual(expectedExecArg0);
    expect(execCallArgs![1]).toBe(SandboxType.NONE);
    expect(execCallArgs![2]).toBeUndefined();
    expect(execCallArgs![3]).toEqual(mockConfig);
  });

  it("should reject command if policy dictates reject", async () => {
    // Use a unique command for this test
    const rejectTestCmd = ["cmd-for-reject-test"];
    const rejectTestInput = { ...mockExecInput, cmd: rejectTestCmd };

    mockedCanAutoApprove.mockReturnValue({
      type: "reject",
      reason: "Command forbidden",
      group: "reject_group",
    } as SafetyAssessment);

    const result = await handleExecCommand(
      rejectTestInput, // Use unique input
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );

    // Assertion should now pass as the command key shouldn't be in the set
    expect(mockedCanAutoApprove).toHaveBeenCalledTimes(1);
    // ... rest of assertions ...
    expect(mockGetCommandConfirmation).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedExecApplyPatch).not.toHaveBeenCalled();
    expect(result.outputText).toBe("aborted");
    expect(result.metadata?.["error"]).toBe("command rejected");
    expect(result.metadata?.["reason"]).toBe(
      "Command rejected by auto-approval system.",
    );
  });

  it("should return stderr and non-zero exit code on exec failure", async () => {
    const errorOutput = "Command failed miserably";
    const exitCode = 127;
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: errorOutput,
      exitCode: exitCode,
    });
    mockedCanAutoApprove.mockReturnValue({
      type: "auto-approve",
      runInSandbox: false,
      applyPatch: undefined,
      reason: "ok",
      group: "ok_group",
    } as SafetyAssessment);

    const result = await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      [],
      mockGetCommandConfirmation,
      undefined,
    );

    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(result.outputText).toBe(errorOutput);
    expect(result.metadata?.["exit_code"]).toBe(exitCode);
  });

  it("should re-run outside sandbox if sandboxed command fails and fullAutoErrorMode is ASK_USER (user approves)", async () => {
    // Use a unique command for this test
    const rerunApproveTestCmd = ["cmd-for-rerun-approve-test"];
    const rerunApproveTestInput = {
      ...mockExecInput,
      cmd: rerunApproveTestCmd,
    };
    mockConfig.fullAutoErrorMode = FullAutoErrorMode.ASK_USER;
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");

    mockedCanAutoApprove.mockReturnValueOnce({
      type: "auto-approve",
      runInSandbox: true,
      applyPatch: undefined,
      reason: "Needs sandbox",
      group: "sandbox_group",
    } as SafetyAssessment);
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "Sandboxed failure",
      exitCode: 1,
    });
    mockedExec.mockResolvedValueOnce({
      stdout: "Success non-sandboxed",
      stderr: "",
      exitCode: 0,
    });
    mockGetCommandConfirmation.mockResolvedValueOnce({
      review: ReviewDecision.YES,
      customDenyMessage: "",
    });

    try {
      const result = await handleExecCommand(
        rerunApproveTestInput, // Use unique input
        mockConfig,
        mockPolicy,
        [],
        mockGetCommandConfirmation,
        undefined,
      );
      // Assertions...
      expect(mockedCanAutoApprove).toHaveBeenCalledTimes(1); // Should pass
      expect(mockedExec).toHaveBeenCalledTimes(2);
      // ... other assertions (e.g., check result output/metadata)
      const firstExecCallArgs = mockedExec.mock.calls[0];
      expect(firstExecCallArgs).toBeDefined();
      expect(firstExecCallArgs![1]).toBe(SandboxType.MACOS_SEATBELT);
      expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);
      const secondExecCallArgs = mockedExec.mock.calls[1];
      expect(secondExecCallArgs).toBeDefined();
      expect(secondExecCallArgs![1]).toBe(SandboxType.NONE);
      expect(result.outputText).toBe("Success non-sandboxed");
      expect(result.metadata?.["exit_code"]).toBe(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("should NOT re-run if sandboxed command fails and fullAutoErrorMode is ASK_USER (user rejects)", async () => {
    mockConfig.fullAutoErrorMode = FullAutoErrorMode.ASK_USER;
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    mockedCanAutoApprove.mockReturnValueOnce({
      type: "auto-approve",
      runInSandbox: true,
      applyPatch: undefined,
      reason: "Needs sandbox",
      group: "sandbox_group",
    } as SafetyAssessment);

    const failureOutput = "Sandboxed failure";
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: failureOutput,
      exitCode: 1,
    });

    // Mock user rejects the second attempt - Use NO_EXIT
    mockGetCommandConfirmation.mockResolvedValueOnce({
      review: ReviewDecision.NO_EXIT,
      customDenyMessage: "",
    });

    try {
      const result = await handleExecCommand(
        mockExecInput,
        mockConfig,
        mockPolicy,
        [],
        mockGetCommandConfirmation, // Called for re-run prompt
        undefined,
      );

      expect(mockedCanAutoApprove).toHaveBeenCalledTimes(1);
      expect(mockedExec).toHaveBeenCalledTimes(1); // Only the first sandboxed call
      expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);

      // Check final result is the "aborted" object from askUserPermission
      expect(result.outputText).toBe("aborted"); // Should return "aborted"
      expect(result.metadata).toEqual({}); // Metadata should be empty from rejection
      expect(result.additionalItems).toBeDefined(); // User rejection message should be present
      const firstItem = result.additionalItems?.[0] as ResponseInputItem & {
        type: "message";
        role: string;
        content: Array<{ type: string; text: string }>;
      };
      expect(firstItem?.content[0]?.text).toContain(
        "No, don't do that — stop for now.",
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  // --- End New Tests ---
});
