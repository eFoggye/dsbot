import { getChannelRule } from "./channelRules.js";
import { parseCaseAssignment } from "./parsers/caseAssignmentParser.js";
import { parseCaseStatus } from "./parsers/caseStatusParser.js";
import { parseDiscipline } from "./parsers/disciplineParser.js";
import { parseInternalOrder } from "./parsers/internalOrdersParser.js";
import { parseStaff } from "./parsers/staffParser.js";
import { parseVacation } from "./parsers/vacationParser.js";
import { buildUnparsedAction } from "./parsers/helpers.js";

const parsersByChannelKey = {
  sk_assignments: parseCaseAssignment,
  sk_cases: parseCaseStatus,
  staff: parseStaff,
  discipline_audit: parseDiscipline,
  vacation_reports: parseVacation,
  internal_orders: parseInternalOrder,
};

export function routeMessageEvent(event) {
  const channel = getChannelRule(event.channelId);
  const eventWithChannel = {
    ...event,
    channel,
  };

  const parser = parsersByChannelKey[channel.key];
  const sheetAction = parser
    ? parser(eventWithChannel)
    : buildUnparsedAction(eventWithChannel, "Для этого канала нет настроенного парсера.");

  return {
    ...eventWithChannel,
    sheetAction,
  };
}
