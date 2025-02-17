import crypto from 'crypto';
import config from '@config';
import {
  EMAIL_PLAN_TYPE,
  OvhExchangeCreationData,
  OvhProCreationData,
} from '@/models/ovh';
import BetaGouv from '@/betagouv';
import * as utils from '@controllers/utils';
import knex from '@/db/index';
import { MemberWithPermission } from '@models/member';
import { DBUser, EmailStatusCode } from '@/models/dbUser/dbUser';
import { addEvent, EventCode } from '@/lib/events';
import { _ } from 'lodash';

const INCUBATORS_USING_EXCHANGE = ['gip-inclusion'];

export async function createEmailAndUpdateSecondaryEmail(
  { username, email }: { username: string; email: string },
  currentUser: string
) {
  const isCurrentUser = currentUser === username;
  const [user, dbUser]: [MemberWithPermission, DBUser] = await Promise.all([
    utils.userInfos(username, isCurrentUser),
    knex('users').where({ username }).first(),
  ]);
  if (!user.userInfos) {
    throw new Error(
      `Le membre ${username} n'a pas de fiche sur Github : vous ne pouvez pas créer son compte email.`
    );
  }

  if (user.isExpired) {
    throw new Error(`Le compte du membre ${username} est expiré.`);
  }

  if (!user.canCreateEmail) {
    throw new Error(
      "Vous n'avez pas le droit de créer le compte email du membre."
    );
  }

  if (!isCurrentUser) {
    const loggedUserInfo = await BetaGouv.userInfosById(currentUser);
    if (utils.checkUserIsExpired(loggedUserInfo)) {
      throw new Error(
        'Vous ne pouvez pas créer le compte email car votre compte a une date de fin expiré sur Github.'
      );
    }
  }
  let emailIsRecreated = false;
  if (dbUser) {
    if (dbUser.email_is_redirection) {
      throw new Error(
        `Le membre ${username} ne peut pas avoir d'email beta.gouv.fr, iel utilise une adresse de redirection.`
      );
    }
    emailIsRecreated =
      dbUser.primary_email_status === EmailStatusCode.EMAIL_DELETED;
    await updateSecondaryEmail(username, email);
  } else {
    await knex('users').insert({
      username,
      primary_email_status: EmailStatusCode.EMAIL_UNSET,
      secondary_email: email,
    });
  }
  await createEmail(username, currentUser, emailIsRecreated);
}

export async function createEmailForUser(req, res) {
  const username = req.sanitize(req.params.username);
  const email = req.sanitize(req.body.to_email);

  try {
    await createEmailAndUpdateSecondaryEmail({ username, email }, req.auth.id);
    req.flash('message', 'Le compte email a bien été créé.');
    res.redirect(`/community/${username}`);
  } catch (err) {
    console.error(err);

    req.flash('error', err.message);
    res.redirect('/community');
  }
}

async function getEmailCreationParams(username: string): Promise<
  | {
      planType: EMAIL_PLAN_TYPE.EMAIL_PLAN_EXCHANGE;
      creationData: OvhExchangeCreationData;
    }
  | { planType: EMAIL_PLAN_TYPE.EMAIL_PLAN_BASIC; password: string }
  | {
      planType: EMAIL_PLAN_TYPE.EMAIL_PLAN_PRO;
      creationData: OvhProCreationData;
    }
> {
  const [usersInfos, startupsInfos] = await Promise.all([
    BetaGouv.usersInfos(),
    BetaGouv.startupsInfos(),
  ]);

  const userInfo = _.find(usersInfos, { id: username });

  const needsExchange = _.some(userInfo?.startups, (id) => {
    const startup = _.find(startupsInfos, { id });
    const incubator = startup?.relationships?.incubator?.data?.id;
    return _.includes(INCUBATORS_USING_EXCHANGE, incubator);
  });

  if (needsExchange) {
    const displayName = userInfo?.fullname ?? '';
    const [firstName, ...lastNames] = displayName.split(' ');
    const lastName = lastNames.join(' ');

    return {
      planType: EMAIL_PLAN_TYPE.EMAIL_PLAN_EXCHANGE,
      creationData: {
        displayName,
        firstName,
        lastName,
      },
    };
  } else if (config.EMAIL_DEFAULT_PLAN === EMAIL_PLAN_TYPE.EMAIL_PLAN_BASIC) {
    const password = crypto.randomBytes(16).toString('base64').slice(0, -2);

    return {
      planType: EMAIL_PLAN_TYPE.EMAIL_PLAN_BASIC,
      password,
    };
  } else {
    const displayName = userInfo?.fullname ?? '';
    const [firstName, ...lastNames] = displayName.split(' ');
    const lastName = lastNames.join(' ');

    return {
      planType: EMAIL_PLAN_TYPE.EMAIL_PLAN_PRO,
      creationData: {
        displayName,
        firstName,
        lastName,
      },
    };
  }
}

export async function createEmail(
  username: string,
  creator: string,
  emailIsRecreated: boolean = false
) {
  const email = utils.buildBetaEmail(username);

  const secretariatUrl = `${config.protocol}://${config.host}`;

  const message = `À la demande de ${creator} sur <${secretariatUrl}>, je lance la création d'un compte mail pour ${username}`;

  await BetaGouv.sendInfoToChat(message);

  const emailCreationParams = await getEmailCreationParams(username);

  switch (emailCreationParams.planType) {
    case EMAIL_PLAN_TYPE.EMAIL_PLAN_EXCHANGE:
      await BetaGouv.createEmailForExchange(
        username,
        emailCreationParams.creationData
      );
      break;
    case EMAIL_PLAN_TYPE.EMAIL_PLAN_BASIC:
      await BetaGouv.createEmail(username, emailCreationParams.password);
      break;
    case EMAIL_PLAN_TYPE.EMAIL_PLAN_PRO:
      await BetaGouv.createEmailPro(username, emailCreationParams.creationData);
      break;
  }

  await knex('users')
    .where({
      username,
    })
    .update({
      primary_email: email,
      primary_email_status: emailIsRecreated
        ? EmailStatusCode.EMAIL_RECREATION_PENDING
        : EmailStatusCode.EMAIL_CREATION_PENDING,
      primary_email_status_updated_at: new Date(),
    });

  addEvent(
    emailIsRecreated
      ? EventCode.MEMBER_EMAIL_RECREATED
      : EventCode.MEMBER_EMAIL_CREATED,
    {
      created_by_username: creator,
      action_on_username: username,
      action_metadata: {
        value: email,
      },
    }
  );
  console.log(`Création de compte by=${creator}&email=${email}`);
}

export async function updateSecondaryEmail(username, secondary_email) {
  return knex('users')
    .where({
      username,
    })
    .update({
      secondary_email,
    });
}
