// Run by contract_test.dart in a process of its own: records a response, then records a
// 5xx over it in update mode, with the note going where it goes by default.
import 'package:contract_fixtures/contract_fixtures.dart';

void main(List<String> arguments) {
  final contract = ContractFixtures(
    side: ContractSide.provider,
    dir: arguments.single,
    update: true,
  );
  for (final status in [201, 500]) {
    contract.verifyResponse(
      name: 'order.created',
      description: 'An order is accepted',
      request: const ExchangeRequest(method: 'POST', path: '/orders'),
      response: ExchangeResponse(status: status),
    );
  }
}
