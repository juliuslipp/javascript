import type { ClerkAPIResponseError } from '@clerk/shared/error';
import { isClerkAPIResponseError } from '@clerk/shared/error';
import type {
  EnvironmentResource,
  OAuthStrategy,
  PrepareFirstFactorParams,
  PrepareSecondFactorParams,
  SignInFactor,
  SignInFirstFactor,
  SignInResource,
  SignInSecondFactor,
  Web3Strategy,
} from '@clerk/types';
import type { ActorRefFrom, ErrorActorEvent, MachineContext } from 'xstate';
import { and, assertEvent, assign, not, or, sendTo, setup } from 'xstate';

import type { ClerkRouter } from '~/react/router';

import type { FormMachine } from './form.machine';
import { waitForClerk } from './shared.actors';
import {
  attemptFirstFactor,
  attemptSecondFactor,
  authenticateWithRedirect,
  createSignIn,
  handleSSOCallback,
  prepareFirstFactor,
  prepareSecondFactor,
} from './sign-in.actors';
import type { LoadedClerkWithEnv } from './sign-in.types';
import { determineStartingSignInFactor, determineStartingSignInSecondFactor } from './sign-in.utils';
import { assertActorEventError } from './utils/assert';

export interface SignInMachineContext extends MachineContext {
  clerk: LoadedClerkWithEnv;
  currentFactor: SignInFactor | null;
  environment?: EnvironmentResource;
  error?: Error | ClerkAPIResponseError;
  formRef: ActorRefFrom<typeof FormMachine>;
  loaded: boolean;
  mode: 'browser' | 'server';
  resource: SignInResource | null;
  router: ClerkRouter;
}

export interface SignInMachineInput {
  clerk: LoadedClerkWithEnv;
  form: ActorRefFrom<typeof FormMachine>;
  router: ClerkRouter;
}

export type SignInMachineEvents =
  | ErrorActorEvent
  | { type: 'AUTHENTICATE.OAUTH'; strategy: OAuthStrategy }
  | { type: 'AUTHENTICATE.WEB3'; strategy: Web3Strategy }
  | { type: 'NEXT' }
  | { type: 'OAUTH.CALLBACK' }
  | { type: 'RETRY' }
  | { type: 'SUBMIT' }
  | { type: 'NAVIGATE'; path: string };

export type SignInTags = 'start' | 'first-factor' | 'second-factor' | 'complete';
export interface SignInMachineTypes {
  context: SignInMachineContext;
  input: SignInMachineInput;
  events: SignInMachineEvents;
  tags: SignInTags;
}

export const SignInMachine = setup({
  actors: {
    // Root
    waitForClerk,

    // Start
    authenticateWithRedirect,
    createSignIn,

    // First Factor
    prepareFirstFactor,
    attemptFirstFactor,

    // Second Factor
    prepareSecondFactor,
    attemptSecondFactor,

    // SSO
    handleSSOCallback,
  },
  actions: {
    debug: ({ context, event }, params?: Record<string, unknown>) => console.dir({ context, event, params }),
    navigateTo({ context }, { path }: { path: string }) {
      context.router.replace(path);
    },
    setAsActive: ({ context }) => {
      const beforeEmit = () => {
        return context.router.push(context.clerk.buildAfterSignInUrl());
      };
      void context.clerk.setActive({ session: context.resource?.createdSessionId, beforeEmit });
    },
    setFormErrors: sendTo(
      ({ context }) => context.formRef,
      ({ event }) => {
        assertActorEventError(event);
        return {
          type: 'ERRORS.SET',
          error: event.error,
        };
      },
    ),
  },
  guards: {
    hasCurrentFactor: ({ context }) => Boolean(context.currentFactor),
    isServer: ({ context }) => context.mode === 'server',
    isBrowser: ({ context }) => context.mode === 'browser',
    isCurrentFactorPassword: ({ context }) => context.currentFactor?.strategy === 'password',
    isCurrentFactorTOTP: ({ context }) => context.currentFactor?.strategy === 'totp',
    isClerkLoaded: ({ context }) => context.clerk.loaded,
    isClerkEnvironmentLoaded: ({ context }) => Boolean(context.clerk.__unstable__environment),
    isSignInComplete: ({ context }) => context?.resource?.status === 'complete',
    isLoggedIn: ({ context }) => Boolean(context.clerk.user),
    isSingleSessionMode: ({ context }) => Boolean(context.clerk.__unstable__environment?.authConfig.singleSessionMode),
    needsIdentifier: ({ context }) =>
      context.clerk.client.signIn.status === 'needs_identifier' || context.resource?.status === 'needs_identifier',
    needsFirstFactor: ({ context }) =>
      context.clerk.client.signIn.status === 'needs_first_factor' || context.resource?.status === 'needs_first_factor',
    needsSecondFactor: ({ context }) =>
      context.clerk.client.signIn.status === 'needs_second_factor' ||
      context.resource?.status === 'needs_second_factor',
    needsNewPassword: ({ context }) =>
      context.clerk.client.signIn.status === 'needs_new_password' || context.resource?.status === 'needs_new_password',
    hasSignInResource: ({ context }) => Boolean(context.clerk.client.signIn || context.resource),
    hasClerkAPIError: ({ context }) => isClerkAPIResponseError(context.error),
    hasClerkAPIErrorCode: ({ context }, params?: { code?: string; error?: Error | ClerkAPIResponseError }) => {
      const err = params?.error && context.error;
      return params?.code && err
        ? isClerkAPIResponseError(err)
          ? Boolean(err.errors.find(e => e.code === params.code))
          : false
        : false;
    },
  },
  types: {} as SignInMachineTypes,
}).createMachine({
  id: 'SignIn',
  context: ({ input }) => ({
    clerk: input.clerk,
    currentFactor: null,
    environment: input.clerk.__unstable__environment,
    formRef: input.form,
    loaded: input.clerk.loaded,
    mode: input.clerk.mode,
    resource: null,
    router: input.router,
  }),
  on: {
    'OAUTH.CALLBACK': '#SignIn.SSOCallbackRunning',
  },
  initial: 'DeterminingState',
  states: {
    DeterminingState: {
      initial: 'Init',
      states: {
        Init: {
          always: [
            {
              description: 'Determine if running on the server',
              guard: 'isServer',
              target: 'Server',
            },
            {
              description: 'Determine if running on the browser',
              guard: 'isBrowser',
              target: 'Browser',
            },
          ],
        },
        Server: {
          type: 'final',
          description: 'Determines the state of the sign-in flow on the server [NOOP]',
          entry: 'debug',
        },
        Browser: {
          type: 'final',
          description: 'Determines the state of the sign-in flow on the browser',
          always: [
            {
              description: 'Wait for the Clerk instance to be ready',
              guard: not('isClerkLoaded'),
              target: '#SignIn.WaitingForClerk',
            },
            {
              description: 'If sign-in complete or loggedin and single-session, skip to complete',
              guard: or(['isSignInComplete', and(['isLoggedIn', 'isSingleSessionMode'])]),
              target: '#SignIn.Complete',
            },
            {
              description: 'If the SignIn resource is empty, invoke the sign-in start flow',
              guard: not('hasSignInResource'),
              target: '#SignIn.Start',
            },
            {
              description: 'Default to the initial sign-in flow state',
              target: '#SignIn.Start',
            },
          ],
        },
      },
    },
    WaitingForClerk: {
      description: 'Waits for the Clerk instance to be ready.',
      invoke: {
        src: 'waitForClerk',
        input: ({ context }) => context.clerk,
        onDone: {
          target: 'DeterminingState',
          reenter: true,
          actions: assign({
            // @ts-expect-error -- this is really IsomorphicClerk up to this point
            clerk: ({ context }) => context.clerk.clerkjs,
            environment: ({ context }) => context.clerk.__unstable__environment,
            loaded: true,
          }),
        },
      },
    },
    Start: {
      description: 'The intial state of the sign-in flow.',
      initial: 'AwaitingInput',
      on: {
        'AUTHENTICATE.OAUTH': '#SignIn.InitiatingOAuthAuthentication',
      },
      states: {
        AwaitingInput: {
          description: 'Waiting for user input',
          on: {
            SUBMIT: {
              target: 'Attempting',
              reenter: true,
            },
          },
        },
        Attempting: {
          invoke: {
            id: 'createSignIn',
            src: 'createSignIn',
            input: ({ context }) => ({
              client: context.clerk.client,
              fields: context.formRef.getSnapshot().context.fields,
            }),
            onDone: {
              actions: [
                assign({
                  resource: ({ event }) => event.output,
                }),
              ],
              target: 'Success',
            },
            onError: {
              actions: 'setFormErrors',
              target: 'AwaitingInput',
            },
          },
        },
        Success: {
          type: 'final',
          always: [
            {
              guard: 'isSignInComplete',
              target: '#SignIn.Complete',
            },
            {
              guard: 'needsFirstFactor',
              target: '#SignIn.FirstFactor',
            },
            {
              guard: 'needsSecondFactor',
              target: '#SignIn.SecondFactor',
            },
            {
              target: '#SignIn.DeterminingState',
              reenter: true,
            },
          ],
        },
        Failure: {
          type: 'final',
          target: '#SignIn.DeterminingState',
        },
      },
    },
    FirstFactor: {
      initial: 'DeterminingState',
      entry: assign({
        currentFactor: ({ context }) =>
          determineStartingSignInFactor(
            context.clerk.client.signIn.supportedFirstFactors,
            context.clerk.client.signIn.identifier,
            context.environment?.displayConfig.preferredSignInStrategy,
          ),
      }),
      states: {
        DeterminingState: {
          always: [
            {
              description: 'If the current factor is not password, prepare the factor',
              guard: not('isCurrentFactorPassword'),
              target: 'Preparing',
              reenter: true,
            },
            {
              description: 'Else, skip to awaiting input',
              target: 'AwaitingInput',
              reenter: true,
            },
          ],
        },
        Preparing: {
          invoke: {
            id: 'prepareFirstFactor',
            src: 'prepareFirstFactor',
            input: ({ context }) => {
              // TODO: Handle the following strategies:
              // - email_link (redirectUrl)
              // - saml (redirectUrl, actionCompleteRedirectUrl)
              // - oauth (redirectUrl, actionCompleteRedirectUrl)

              return {
                client: context.clerk.client,
                params: !context.currentFactor ? null : (context.currentFactor as PrepareFirstFactorParams),
              };
            },
            onDone: {
              target: 'AwaitingInput',
              actions: [
                assign({
                  resource: ({ event }) => event.output,
                }),
              ],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Failure',
            },
          },
        },
        AwaitingInput: {
          description: 'Waiting for user input',
          on: {
            SUBMIT: {
              target: 'Attempting',
              reenter: true,
            },
          },
        },
        Attempting: {
          invoke: {
            id: 'attemptFirstFactor',
            src: 'attemptFirstFactor',
            input: ({ context }) => ({
              client: context.clerk.client,
              params: {
                currentFactor: context.currentFactor as SignInFirstFactor,
                fields: context.formRef.getSnapshot().context.fields,
              },
            }),
            onDone: {
              actions: [
                assign({
                  resource: ({ event }) => event.output,
                }),
              ],
              target: 'Success',
            },
            onError: {
              actions: 'setFormErrors',
              target: 'AwaitingInput',
            },
          },
        },
        Success: {
          type: 'final',
          always: [
            {
              guard: 'isSignInComplete',
              target: '#SignIn.Complete',
            },
            {
              guard: 'needsFirstFactor',
              target: '#SignIn.FirstFactor',
            },
            {
              guard: 'needsSecondFactor',
              target: '#SignIn.SecondFactor',
            },
            {
              target: '#SignIn.DeterminingState',
              reenter: true,
            },
          ],
        },
        Failure: {
          type: 'final',
          target: '#SignIn.DeterminingState',
        },
      },
    },
    SecondFactor: {
      initial: 'DeterminingState',
      entry: assign({
        currentFactor: ({ context }) =>
          determineStartingSignInSecondFactor(context.clerk.client.signIn.supportedSecondFactors),
      }),
      states: {
        DeterminingState: {
          always: [
            {
              description: 'If the current factor is not TOTP, prepare the factor',
              guard: not('isCurrentFactorTOTP'),
              target: 'Preparing',
              reenter: true,
            },
            {
              description: 'Else, skip to awaiting input',
              target: 'AwaitingInput',
              reenter: true,
            },
          ],
        },
        Preparing: {
          invoke: {
            id: 'prepareSecondFactor',
            src: 'prepareSecondFactor',
            input: ({ context }) => {
              return {
                client: context.clerk.client,
                params: !context.currentFactor ? null : (context.currentFactor as PrepareSecondFactorParams),
              };
            },
            onDone: {
              target: 'AwaitingInput',
              actions: [
                assign({
                  resource: ({ event }) => event.output,
                }),
              ],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Failure',
            },
          },
        },
        AwaitingInput: {
          description: 'Waiting for user input',
          on: {
            SUBMIT: {
              target: 'Attempting',
              reenter: true,
            },
          },
        },
        Attempting: {
          invoke: {
            id: 'attemptSecondFactor',
            src: 'attemptSecondFactor',
            input: ({ context }) => ({
              client: context.clerk.client,
              params: {
                currentFactor: context.currentFactor as SignInSecondFactor,
                fields: context.formRef.getSnapshot().context.fields,
              },
            }),
            onDone: {
              actions: [
                assign({
                  resource: ({ event }) => event.output,
                }),
              ],
              target: 'Success',
            },
            onError: {
              actions: 'setFormErrors',
              target: 'AwaitingInput',
            },
          },
        },
        Success: {
          type: 'final',
          always: [
            {
              guard: 'isSignInComplete',
              target: '#SignIn.Complete',
            },
            {
              target: '#SignIn.DeterminingState',
              reenter: true,
            },
          ],
        },
        Failure: {
          type: 'final',
          target: '#SignIn.DeterminingState',
        },
      },
    },
    SSOCallbackRunning: {
      invoke: {
        src: 'handleSSOCallback',
        input: ({ context }) => ({
          clerk: context.clerk,
          params: {
            firstFactorUrl: '../factor-one',
            secondFactorUrl: '../factor-two',
          },
          router: context.router,
        }),
        onDone: {
          actions: assign({ resource: ({ event }) => event.output as SignInResource }),
        },
        onError: {
          actions: 'setFormErrors',
        },
      },
      always: [
        {
          guard: ({ context }) => context?.resource?.status === 'complete',
          target: 'Complete',
        },
        {
          guard: ({ context }) => context?.resource?.status === 'needs_first_factor',
          target: 'FirstFactor',
        },
      ],
    },
    InitiatingOAuthAuthentication: {
      invoke: {
        src: 'authenticateWithRedirect',
        input: ({ context, event }) => {
          assertEvent(event, 'AUTHENTICATE.OAUTH');

          return {
            clerk: context.clerk,
            environment: context.environment,
            strategy: event.strategy,
          };
        },
        onError: {
          actions: 'setFormErrors',
        },
      },
    },
    HavingTrouble: {
      type: 'final',
      on: {
        // RESTART: '#SignIn.Start',
      },
    },
    Complete: {
      type: 'final',
      entry: 'setAsActive',
    },
  },
});
